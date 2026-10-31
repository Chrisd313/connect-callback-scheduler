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
   * Callbacks already DISPATCHED, FAILED or CANCELLED are left alone.
   *
   * Each callback is marked CANCELLED before its schedule is deleted. If the delete
   * fails the record is already CANCELLED, so dispatchCallback will skip it should the
   * schedule still fire; the other order could leave a SCHEDULED record with no schedule.
   */
  async cancelForPhoneNumber(rawPhoneNumber: string): Promise<CancelCallbacksResult> {
    const phoneNumber = normaliseUkPhoneNumber(rawPhoneNumber);
    const candidates = await this.deps.repository.findScheduledByPhoneNumber(phoneNumber);

    let cancelledCount = 0;
    const failures: unknown[] = [];

    for (const record of candidates) {
      // The index query already restricts to SCHEDULED; this is belt and braces
      // against a stale index read.
      if (record.status !== "SCHEDULED") continue;

      try {
        const cancelled = await this.deps.repository.transitionStatus(
          record.callbackId,
          "SCHEDULED",
          "CANCELLED",
        );
        if (!cancelled) {
          // Dispatched (or cancelled elsewhere) between our query and update. Not ours to touch.
          log("info", "Callback no longer SCHEDULED, not cancelling", { callbackId: record.callbackId });
          continue;
        }

        cancelledCount++; // the record is CANCELLED from here on, whatever happens to the schedule

        const scheduleDeleted = await this.deps.scheduler.cancelDispatch(record.callbackId);
        log("info", "Callback cancelled", {
          callbackId: record.callbackId,
          phone: maskPhone(phoneNumber),
          scheduleDeleted,
        });
      } catch (err) {
        // Carry on with the rest; one bad record shouldn't leave the others pending.
        failures.push(err);
        log("error", "Failed to cancel callback", {
          callbackId: record.callbackId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to cancel ${failures.length} of ${candidates.length} callbacks (${cancelledCount} cancelled)`,
      );
    }

    return { cancelledCount };
  }
}
