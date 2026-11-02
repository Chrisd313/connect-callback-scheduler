import { log, maskPhone } from "./logger.js";
import type { CallbackRepository } from "./repository.js";
import type { CallbackScheduler } from "./scheduler.js";
import { normaliseUkPhoneNumber } from "./validation.js";

export interface CancelCallbackServiceDeps {
  repository: CallbackRepository;
  scheduler: CallbackScheduler;
}

export interface CancelCallbacksResult {
  /** Callbacks moved from SCHEDULED to CANCELLED by this call. */
  cancelledCount: number;
  /**
   * Callbacks that were cancelled but whose schedule could not be deleted. The customer
   * outcome is unaffected (dispatchCallback skips a CANCELLED record if the schedule
   * fires), so this is for logging, not for the flow.
   */
  scheduleDeleteFailures: number;
}

/**
 * Thrown when one or more status updates failed. Carries how many callbacks *were*
 * cancelled before/around the failure so the handler can pass that on to the flow.
 */
export class CancelCallbacksError extends AggregateError {
  constructor(
    errors: unknown[],
    message: string,
    readonly cancelledCount: number,
  ) {
    super(errors, message);
    this.name = "CancelCallbacksError";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Cancels pending callbacks when a customer rings back in before we've called them.
 * Kept separate from CallbackService so the cancel Lambda has no dependency on the
 * callback-hours configuration.
 */
export class CancelCallbackService {
  constructor(private readonly deps: CancelCallbackServiceDeps) {}

  /**
   * Cancels every SCHEDULED callback for a phone number (any UK format).
   * Callbacks already DISPATCHING, DISPATCHED, FAILED or CANCELLED are left alone.
   *
   * The SCHEDULED -> CANCELLED update is conditional, and dispatchCallback claims a record
   * (SCHEDULED -> DISPATCHING) before it calls Connect. So if a dispatch is racing us,
   * exactly one side wins: either our update succeeds and the dispatch places no call, or
   * the dispatch has already claimed the record and we don't count it as cancelled. A
   * customer whose call is being placed at that moment therefore gets NONE_FOUND.
   *
   * Each callback is marked CANCELLED before its schedule is deleted. If the delete
   * fails the record is already CANCELLED, so dispatchCallback will skip it should the
   * schedule still fire; the other order could leave a SCHEDULED record with no schedule.
   *
   * Because of that ordering, a failed schedule delete is not a failed cancel: it is
   * logged and counted in scheduleDeleteFailures, and the callback still counts as
   * cancelled. Only a failed status update is a failure, reported by throwing a
   * CancelCallbacksError once every candidate has been attempted.
   *
   * A thrown status update doesn't prove the write didn't apply (a DynamoDB timeout can
   * land after the write). A retry would then find nothing SCHEDULED and report
   * NONE_FOUND for a callback that was in fact cancelled. Not handled here.
   */
  async cancelForPhoneNumber(rawPhoneNumber: string): Promise<CancelCallbacksResult> {
    const phoneNumber = normaliseUkPhoneNumber(rawPhoneNumber);
    const candidates = await this.deps.repository.findScheduledByPhoneNumber(phoneNumber);

    let cancelledCount = 0;
    let scheduleDeleteFailures = 0;
    const failures: unknown[] = [];

    for (const record of candidates) {
      // The index query already restricts to SCHEDULED; this is belt and braces
      // against a stale index read.
      if (record.status !== "SCHEDULED") continue;

      let cancelled: boolean;
      try {
        cancelled = await this.deps.repository.transitionStatus(record.callbackId, "SCHEDULED", "CANCELLED");
      } catch (err) {
        // Carry on with the rest; one bad record shouldn't leave the others pending.
        failures.push(err);
        log("error", "Failed to cancel callback", {
          callbackId: record.callbackId,
          error: errorMessage(err),
        });
        continue;
      }

      if (!cancelled) {
        // Claimed by a dispatch (or cancelled elsewhere) between our query and update.
        // Not ours to touch, and not reported as cancelled.
        log("info", "Callback no longer SCHEDULED, not cancelling", { callbackId: record.callbackId });
        continue;
      }

      cancelledCount++; // the record is CANCELLED from here on, whatever happens to the schedule

      let scheduleDeleted: boolean;
      try {
        // A record waiting for a retry has an attempt-specific schedule; see scheduleName.
        scheduleDeleted = await this.deps.scheduler.cancelDispatch(record.callbackId, record.attempts ?? 0);
      } catch (err) {
        // The cancel has worked; the schedule will fire into a CANCELLED record and be
        // skipped. Visible to us, invisible to the customer.
        scheduleDeleteFailures++;
        log("error", "Callback cancelled but its schedule could not be deleted", {
          callbackId: record.callbackId,
          error: errorMessage(err),
        });
        continue;
      }

      log("info", "Callback cancelled", {
        callbackId: record.callbackId,
        phone: maskPhone(phoneNumber),
        scheduleDeleted,
      });
    }

    if (failures.length > 0) {
      throw new CancelCallbacksError(
        failures,
        `Failed to cancel ${failures.length} of ${candidates.length} callbacks (${cancelledCount} cancelled)`,
        cancelledCount,
      );
    }

    return { cancelledCount, scheduleDeleteFailures };
  }
}
