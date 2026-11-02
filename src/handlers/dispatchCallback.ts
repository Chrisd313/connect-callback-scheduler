import { ConnectClient, StartOutboundVoiceContactCommand } from "@aws-sdk/client-connect";
import { loadConfig, type AppConfig } from "../lib/config.js";
import { isTransientConnectError } from "../lib/connectErrors.js";
import { log, maskPhone } from "../lib/logger.js";
import { CallbackRepository } from "../lib/repository.js";
import { CallbackScheduler } from "../lib/scheduler.js";
import type { CallbackRecord, DispatchEvent } from "../lib/types.js";

interface DispatchDeps {
  config: AppConfig;
  repository: CallbackRepository;
  connect: ConnectClient;
  scheduler: CallbackScheduler;
  /** Injectable for tests that assert on times. */
  clock?: () => Date;
}

let deps: DispatchDeps | undefined;

function getDeps(): DispatchDeps {
  if (!deps) {
    const config = loadConfig();
    deps = {
      config,
      repository: new CallbackRepository(config.tableName),
      connect: new ConnectClient({}),
      scheduler: new CallbackScheduler({
        dispatchFunctionArn: config.dispatchFunctionArn,
        schedulerRoleArn: config.schedulerRoleArn,
        scheduleGroupName: config.scheduleGroupName,
      }),
    };
  }
  return deps;
}

/** Test hook: swap in mocked dependencies. */
export function setDepsForTesting(d: DispatchDeps | undefined): void {
  deps = d;
}

/** Fixed message so the SAM template's metric filter and the README's Insights queries can match it. */
export const FINAL_FAILURE_MESSAGE = "Callback dispatch failed permanently";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Seconds since the record was last updated, or undefined if updatedAt is unusable. */
function secondsSince(record: CallbackRecord, now: Date): number | undefined {
  const updatedAt = Date.parse(record.updatedAt);
  return Number.isFinite(updatedAt) ? Math.round((now.getTime() - updatedAt) / 1000) : undefined;
}

/**
 * Invoked by EventBridge Scheduler at the scheduled callback time, and again by the
 * retry schedules this handler creates for itself after a transient Connect error.
 * Places the outbound call into the original queue so the next available agent takes it.
 *
 * Ordering matters here. The record is claimed (SCHEDULED -> DISPATCHING) with a
 * conditional update *before* Connect is called, so that:
 *   - a cancel that commits first makes the claim fail and no call is placed;
 *   - a cancel that arrives after the claim (including while the Connect call is in
 *     flight) finds the record no longer SCHEDULED and reports nothing cancelled;
 *   - a duplicate or retried invocation finds the record claimed and does not call again.
 *
 * Retries are this handler's own doing, not the invoker's: on a transient error it
 * creates a new one-time schedule for the next attempt and releases the claim
 * (DISPATCHING -> SCHEDULED, attempts + 1). A handled Connect outcome, retry scheduled or
 * final failure, therefore returns normally. Only infrastructure errors (DynamoDB,
 * Scheduler) are thrown, because those are the cases where an invoker-level retry of
 * the whole invocation can help.
 */
export async function handler(event: DispatchEvent): Promise<void> {
  const { config, repository, connect, scheduler, clock } = getDeps();
  const now = clock ? clock() : new Date();

  const record = await repository.get(event.callbackId);
  if (!record) {
    log("warn", "Dispatch fired for unknown callback", { callbackId: event.callbackId });
    return;
  }

  if (record.status === "DISPATCHING") {
    // An earlier invocation claimed this callback and has not recorded an outcome. It may
    // still be running (a duplicate delivery), or it may have died with the Connect call
    // in flight. Either way we can't tell whether the customer's phone rang, so we don't
    // call again: a missed callback is better than a double call. If the claim is stale
    // the record stays DISPATCHING, and this log line is how it surfaces. Recovering
    // stale claims is deliberately not attempted here; see README "Callback statuses"
    // (tracked as CCB-156).
    log("warn", "Callback claimed by an earlier dispatch that is still running or did not complete; not calling again", {
      callbackId: record.callbackId,
      claimedAt: record.updatedAt,
      claimAgeSeconds: secondsSince(record, now),
    });
    return;
  }

  if (record.status !== "SCHEDULED") {
    // Cancelled, failed, or a retried invocation after a successful dispatch. Nothing to do.
    log("info", "Skipping dispatch, callback not in SCHEDULED state", {
      callbackId: record.callbackId,
      status: record.status,
    });
    return;
  }

  // Claim the record. This is the only guard that counts: the read above may be stale.
  let claimed: boolean;
  try {
    claimed = await repository.transitionStatus(record.callbackId, "SCHEDULED", "DISPATCHING", {}, now);
  } catch (err) {
    // Don't call Connect without a confirmed claim. Note a thrown update may still have
    // applied (e.g. a timeout after the write landed); a retry then takes the DISPATCHING
    // path above and does not call either.
    log("error", "Could not claim callback for dispatch; not calling", {
      callbackId: record.callbackId,
      error: errorMessage(err),
    });
    throw err;
  }
  if (!claimed) {
    // Cancelled, or claimed by a concurrent invocation, between our read and this update.
    log("info", "Callback no longer SCHEDULED, not dispatching", { callbackId: record.callbackId });
    return;
  }

  const attempt = (record.attempts ?? 0) + 1;
  const maxAttempts = config.dispatchMaxAttempts;

  // Logged before the Connect call so that, if this invocation times out mid-call, the
  // runtime's timeout line can be tied to a callbackId via the request ID.
  log("info", "Callback claimed, calling Connect", { callbackId: record.callbackId, attempt, maxAttempts });

  let outboundContactId: string | undefined;
  try {
    const response = await connect.send(
      new StartOutboundVoiceContactCommand({
        InstanceId: config.connectInstanceId,
        ContactFlowId: config.outboundContactFlowId,
        QueueId: record.queueId,
        DestinationPhoneNumber: record.phoneNumber,
        Attributes: {
          callbackId: record.callbackId,
          sourceContactId: record.sourceContactId,
        },
        // Same token on every attempt: if an earlier attempt did reach Connect despite
        // erroring on our side, Connect treats the retry as the same request.
        ClientToken: record.callbackId,
      }),
    );
    outboundContactId = response.ContactId;
  } catch (err) {
    await handleConnectFailure({ config, repository, scheduler }, record, attempt, err, now);
    return;
  }

  // The call has been placed. From here on the record must not become FAILED.
  try {
    const moved = await repository.transitionStatus(record.callbackId, "DISPATCHING", "DISPATCHED", {
      outboundContactId,
      attempts: attempt,
    });
    if (!moved) {
      // Nothing else writes to a DISPATCHING record, so this shouldn't happen.
      log("warn", "Call placed but callback was no longer DISPATCHING; status not updated", {
        callbackId: record.callbackId,
        outboundContactId,
      });
    }
  } catch (err) {
    log("error", "Call placed but could not mark callback DISPATCHED; record left DISPATCHING", {
      callbackId: record.callbackId,
      outboundContactId,
      error: errorMessage(err),
    });
    throw err;
  }

  log("info", "Callback dispatched", {
    callbackId: record.callbackId,
    outboundContactId,
    attempt,
    phone: maskPhone(record.phoneNumber),
  });
}

/**
 * Decides between scheduling another attempt and giving up. Either way the claim is
 * resolved (DISPATCHING -> SCHEDULED or -> FAILED) and nothing is thrown unless the
 * resolution itself fails.
 */
async function handleConnectFailure(
  deps: Pick<DispatchDeps, "config" | "repository" | "scheduler">,
  record: CallbackRecord,
  attempt: number,
  err: unknown,
  now: Date,
): Promise<void> {
  const { config, repository, scheduler } = deps;
  const reason = errorMessage(err);
  const transient = isTransientConnectError(err);
  const maxAttempts = config.dispatchMaxAttempts;
  const base = { callbackId: record.callbackId, attempt, maxAttempts, error: reason };

  if (!transient || attempt >= maxAttempts) {
    await markFailed(repository, record, attempt, reason, { ...base, retryable: transient });
    return;
  }

  const retryAt = new Date(now.getTime() + config.dispatchRetryDelaySeconds * 1000);

  // Create the retry schedule first, then release the claim. The other order could
  // leave a SCHEDULED record with nothing to fire it, which nobody would ever notice.
  // This order's failure mode is a DISPATCHING record with a schedule that will fire
  // into it and log the stale-claim warning.
  try {
    await scheduler.scheduleDispatch(record.callbackId, retryAt, attempt);
  } catch (scheduleErr) {
    log("error", "Could not schedule retry", { ...base, scheduleError: errorMessage(scheduleErr) });
    await markFailed(
      repository,
      record,
      attempt,
      `${reason} (retry could not be scheduled: ${errorMessage(scheduleErr)})`,
      { ...base, retryable: true },
    );
    return;
  }

  try {
    const released = await repository.transitionStatus(
      record.callbackId,
      "DISPATCHING",
      "SCHEDULED",
      { attempts: attempt, failureReason: reason },
      now,
    );
    if (!released) {
      log("warn", "Retry scheduled but callback was no longer DISPATCHING; status not updated", {
        ...base,
        retryAt: retryAt.toISOString(),
      });
      return;
    }
  } catch (releaseErr) {
    log("error", "Retry scheduled but could not release claim; record left DISPATCHING", {
      ...base,
      retryAt: retryAt.toISOString(),
      releaseError: errorMessage(releaseErr),
    });
    throw releaseErr;
  }

  log("warn", "Callback dispatch failed, retry scheduled", { ...base, retryAt: retryAt.toISOString() });
}

async function markFailed(
  repository: CallbackRepository,
  record: CallbackRecord,
  attempt: number,
  failureReason: string,
  fields: Record<string, unknown>,
): Promise<void> {
  // Logged before the write so the final failure is visible (and the alarm fires) even
  // if the write below fails.
  log("error", FINAL_FAILURE_MESSAGE, fields);

  try {
    const moved = await repository.transitionStatus(record.callbackId, "DISPATCHING", "FAILED", {
      attempts: attempt,
      failureReason,
    });
    if (!moved) {
      // Nothing else writes to a DISPATCHING record, so this shouldn't happen.
      log("warn", "Connect call failed but callback was no longer DISPATCHING; status not updated", {
        callbackId: record.callbackId,
      });
    }
  } catch (updateErr) {
    log("error", "Could not mark callback FAILED; record left DISPATCHING", {
      callbackId: record.callbackId,
      error: errorMessage(updateErr),
    });
    throw updateErr;
  }
}
