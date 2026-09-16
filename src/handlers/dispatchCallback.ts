import { ConnectClient, StartOutboundVoiceContactCommand } from "@aws-sdk/client-connect";
import { loadConfig, type AppConfig } from "../lib/config.js";
import { log, maskPhone } from "../lib/logger.js";
import { CallbackRepository } from "../lib/repository.js";
import type { DispatchEvent } from "../lib/types.js";

interface DispatchDeps {
  config: AppConfig;
  repository: CallbackRepository;
  connect: ConnectClient;
}

let deps: DispatchDeps | undefined;

function getDeps(): DispatchDeps {
  if (!deps) {
    const config = loadConfig();
    deps = {
      config,
      repository: new CallbackRepository(config.tableName),
      connect: new ConnectClient({}),
    };
  }
  return deps;
}

/** Test hook: swap in mocked dependencies. */
export function setDepsForTesting(d: DispatchDeps | undefined): void {
  deps = d;
}

/**
 * Invoked by EventBridge Scheduler at the scheduled callback time.
 * Places the outbound call into the original queue so the next available agent takes it.
 */
export async function handler(event: DispatchEvent): Promise<void> {
  const { config, repository, connect } = getDeps();

  const record = await repository.get(event.callbackId);
  if (!record) {
    log("warn", "Dispatch fired for unknown callback", { callbackId: event.callbackId });
    return;
  }

  if (record.status !== "SCHEDULED") {
    // Cancelled, or Scheduler retried after a successful dispatch. Nothing to do.
    log("info", "Skipping dispatch, callback not in SCHEDULED state", {
      callbackId: record.callbackId,
      status: record.status,
    });
    return;
  }

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
        ClientToken: record.callbackId,
      }),
    );

    const moved = await repository.transitionStatus(record.callbackId, "SCHEDULED", "DISPATCHED", {
      outboundContactId: response.ContactId,
    });

    log("info", "Callback dispatched", {
      callbackId: record.callbackId,
      outboundContactId: response.ContactId,
      phone: maskPhone(record.phoneNumber),
      statusUpdated: moved,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await repository.transitionStatus(record.callbackId, "SCHEDULED", "FAILED", {
      failureReason: reason,
    });
    log("error", "Failed to dispatch callback", { callbackId: record.callbackId, error: reason });
    // Rethrow so Scheduler's retry policy gets a chance; the status guard stops a double call.
    throw err;
  }
}
