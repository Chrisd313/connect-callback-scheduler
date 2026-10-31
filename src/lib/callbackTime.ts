import { isOpenAt, nextOpening, type CallbackHours } from "./callbackHours.js";
import { ValidationError } from "./validation.js";

/** `reason` values returned to the contact flow when a preferred time can't be booked. */
export const CallbackTimeReason = {
  OUTSIDE_CALLBACK_HOURS: "OUTSIDE_CALLBACK_HOURS",
  TOO_FAR_AHEAD: "TOO_FAR_AHEAD",
} as const;

export interface ResolveCallbackTimeInput {
  now: Date;
  /** Time the customer asked for, if any. */
  preferredTime?: Date;
  /** Minutes after `now` to call back when no preferred time is given. */
  defaultDelayMinutes: number;
  /** Preferred times later than `now` + this many days are rejected. */
  maxDaysAhead: number;
  hours: CallbackHours;
}

/**
 * Works out when a callback should be placed.
 *
 * - No preferred time: call back after the default delay, or if that's outside
 *   callback hours (including the closing buffer), at the next opening.
 * - Preferred time: honoured as-is if within the booking window and callback hours,
 *   otherwise rejected so the flow can ask the customer for another time. We
 *   deliberately don't move a customer's chosen time for them.
 */
export function resolveCallbackTime(input: ResolveCallbackTimeInput): Date {
  const { now, preferredTime, defaultDelayMinutes, maxDaysAhead, hours } = input;

  if (!preferredTime) {
    const afterDelay = new Date(now.getTime() + defaultDelayMinutes * 60_000);
    return nextOpening(afterDelay, hours);
  }

  const latestBookable = now.getTime() + maxDaysAhead * 86_400_000;
  if (preferredTime.getTime() > latestBookable) {
    throw new ValidationError(
      `Preferred callback time is more than ${maxDaysAhead} days ahead`,
      CallbackTimeReason.TOO_FAR_AHEAD,
    );
  }
  if (!isOpenAt(preferredTime, hours)) {
    throw new ValidationError(
      "Preferred callback time is outside callback hours",
      CallbackTimeReason.OUTSIDE_CALLBACK_HOURS,
    );
  }
  return preferredTime;
}

/**
 * EventBridge Scheduler one-time schedules take `at(yyyy-mm-ddThh:mm:ss)` with no offset;
 * the timezone is supplied separately via ScheduleExpressionTimezone. We always pass UTC,
 * so the local-time reasoning above never leaks into the schedule itself.
 */
export function toSchedulerAtExpression(when: Date): string {
  const iso = when.toISOString(); // 2026-11-02T14:30:00.000Z
  return `at(${iso.slice(0, 19)})`;
}
