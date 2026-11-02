import type { ConnectContactFlowEvent, ConnectContactFlowResult } from "aws-lambda";
import { CancelCallbackService, CancelCallbacksError } from "../lib/cancelCallbackService.js";
import { loadConfig } from "../lib/config.js";
import { log } from "../lib/logger.js";
import { CallbackRepository } from "../lib/repository.js";
import { CallbackScheduler } from "../lib/scheduler.js";
import { ValidationError } from "../lib/validation.js";

let service: CancelCallbackService | undefined;

function getService(): CancelCallbackService {
  if (!service) {
    const config = loadConfig();
    service = new CancelCallbackService({
      repository: new CallbackRepository(config.tableName),
      scheduler: new CallbackScheduler({
        dispatchFunctionArn: config.dispatchFunctionArn,
        schedulerRoleArn: config.schedulerRoleArn,
        scheduleGroupName: config.scheduleGroupName,
      }),
    });
  }
  return service;
}

/** Test hook: swap in a service with mocked dependencies. */
export function setServiceForTesting(s: CancelCallbackService | undefined): void {
  service = s;
}

/**
 * Invoked from the inbound contact flow when a customer with a pending callback
 * chooses to cancel it. Cancels every SCHEDULED callback for the caller's number.
 *
 * Returns a flat map for the flow to branch on:
 *   result: CANCELLED   cancelledCount: "1"
 *   result: NONE_FOUND  cancelledCount: "0"
 *   result: INVALID     reason: MISSING_DETAILS | <message>
 *   result: ERROR       reason: INTERNAL_ERROR   cancelledCount: "1" (only when a status
 *                       update failed after others were attempted; absent if we failed
 *                       before any update, e.g. the lookup itself)
 *
 * ERROR on a mixed outcome is deliberate: a callback whose update failed is (probably)
 * still SCHEDULED and will ring, so CANCELLED would be a false promise. A schedule delete
 * failure alone is not an error; the record is CANCELLED and that is what counts.
 *
 * Like createCallback, this never throws: an exception sends the caller down the flow's
 * error branch with no explanation.
 */
export async function handler(event: ConnectContactFlowEvent): Promise<ConnectContactFlowResult> {
  const contact = event.Details.ContactData;
  const params = event.Details.Parameters ?? {};

  const phoneNumber = params.callbackNumber || contact.CustomerEndpoint?.Address;
  if (!phoneNumber) {
    log("warn", "Cancel request missing phone number", { contactId: contact.ContactId });
    return { result: "INVALID", reason: "MISSING_DETAILS" };
  }

  try {
    const { cancelledCount, scheduleDeleteFailures } = await getService().cancelForPhoneNumber(phoneNumber);

    log("info", "Cancel request handled", { contactId: contact.ContactId, cancelledCount, scheduleDeleteFailures });
    return {
      result: cancelledCount > 0 ? "CANCELLED" : "NONE_FOUND",
      cancelledCount: String(cancelledCount),
    };
  } catch (err) {
    if (err instanceof ValidationError) {
      // Don't log err.message here: for a bad phone number it echoes the number back.
      log("warn", "Cancel request rejected", { contactId: contact.ContactId, reason: err.code ?? "INVALID_PHONE" });
      return { result: "INVALID", reason: err.code ?? err.message };
    }
    log("error", "Failed to cancel callbacks", {
      contactId: contact.ContactId,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof CancelCallbacksError ? { cancelledCount: err.cancelledCount } : {}),
    });
    if (err instanceof CancelCallbacksError) {
      return { result: "ERROR", reason: "INTERNAL_ERROR", cancelledCount: String(err.cancelledCount) };
    }
    return { result: "ERROR", reason: "INTERNAL_ERROR" };
  }
}
