import type { ConnectContactFlowEvent, ConnectContactFlowResult } from "aws-lambda";
import { CallbackService } from "../lib/callbackService.js";
import { loadConfig } from "../lib/config.js";
import { log } from "../lib/logger.js";
import { CallbackRepository } from "../lib/repository.js";
import { CallbackScheduler } from "../lib/scheduler.js";
import { ValidationError } from "../lib/validation.js";

let service: CallbackService | undefined;

function getService(): CallbackService {
  if (!service) {
    const config = loadConfig();
    service = new CallbackService({
      repository: new CallbackRepository(config.tableName),
      scheduler: new CallbackScheduler({
        dispatchFunctionArn: config.dispatchFunctionArn,
        schedulerRoleArn: config.schedulerRoleArn,
        scheduleGroupName: config.scheduleGroupName,
      }),
      defaultCallbackDelayMinutes: config.defaultCallbackDelayMinutes,
      maxBookingDaysAhead: config.maxBookingDaysAhead,
      callbackHours: config.callbackHours,
      recordRetentionDays: config.recordRetentionDays,
    });
  }
  return service;
}

/** Test hook: swap in a service with mocked dependencies. */
export function setServiceForTesting(s: CallbackService | undefined): void {
  service = s;
}

/**
 * Invoked from the "Offer callback" contact flow via an Invoke AWS Lambda function block.
 *
 * Connect needs a flat map of string values back, and branches on `result`.
 * We never throw from here: an exception sends the caller down the flow's error
 * branch with no explanation, which is worse than a handled failure.
 */
export async function handler(event: ConnectContactFlowEvent): Promise<ConnectContactFlowResult> {
  const contact = event.Details.ContactData;
  const params = event.Details.Parameters ?? {};

  const phoneNumber = params.callbackNumber || contact.CustomerEndpoint?.Address;
  const queueId = params.queueId || contact.Queue?.ARN?.split("/").pop();

  if (!phoneNumber || !queueId) {
    log("warn", "Callback request missing phone number or queue", { contactId: contact.ContactId });
    return { result: "INVALID", reason: "MISSING_DETAILS" };
  }

  try {
    const outcome = await getService().createCallback({
      sourceContactId: contact.ContactId,
      phoneNumber,
      queueId,
      preferredTime: params.preferredTime,
    });

    return {
      result: "SCHEDULED",
      callbackId: outcome.callbackId,
      scheduledFor: outcome.scheduledFor,
      scheduledForLocal: outcome.scheduledForLocal,
    };
  } catch (err) {
    if (err instanceof ValidationError) {
      log("warn", "Callback request rejected", {
        contactId: contact.ContactId,
        reason: err.code,
        error: err.message,
      });
      // Newer checks carry a code the flow branches on; older ones only have a message.
      return { result: "INVALID", reason: err.code ?? err.message };
    }
    log("error", "Failed to schedule callback", {
      contactId: contact.ContactId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { result: "ERROR", reason: "INTERNAL_ERROR" };
  }
}
