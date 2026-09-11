/**
 * Works out when a callback should be placed.
 *
 * If the customer asked for a specific time we honour it, otherwise we call back
 * after the default delay.
 */
export function resolveCallbackTime(
  now: Date,
  preferredTime: Date | undefined,
  defaultDelayMinutes: number,
): Date {
  if (preferredTime) {
    return preferredTime;
  }
  return new Date(now.getTime() + defaultDelayMinutes * 60_000);
}

/**
 * EventBridge Scheduler one-time schedules take `at(yyyy-mm-ddThh:mm:ss)` with no offset;
 * the timezone is supplied separately via ScheduleExpressionTimezone. We always pass UTC.
 */
export function toSchedulerAtExpression(when: Date): string {
  const iso = when.toISOString(); // 2026-11-02T14:30:00.000Z
  return `at(${iso.slice(0, 19)})`;
}
