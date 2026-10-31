import {
  addDays,
  fromLocalDateTime,
  toIsoDate,
  toLocalDateTime,
  weekdayOf,
  type LocalDate,
} from "./localTime.js";

/** Opening and closing wall-clock times for one day, "HH:MM" 24-hour. */
export interface DayHours {
  open: string;
  close: string;
}

/** 0 = Sunday ... 6 = Saturday, matching Date#getDay. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * When agents are available to take callbacks. Purely data: change this (or supply a
 * different one) to alter hours without touching the scheduling logic.
 */
export interface CallbackHours {
  /** IANA zone the hours are expressed in, e.g. "Europe/London". */
  timeZone: string;
  /** Hours per weekday. Days with no entry are closed. */
  weekly: Partial<Record<Weekday, DayHours>>;
  /** Whole days we're closed regardless of weekday, as "YYYY-MM-DD" local dates (bank holidays). */
  closedDates: readonly string[];
  /**
   * Treat this many minutes before close as closed, so we don't schedule a callback
   * that agents won't have time to work before they go home.
   */
  closingBufferMinutes: number;
}

function parseHhMm(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Callback hours must be "HH:MM", got "${value}"`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Callback hours out of range: "${value}"`);
  return hours * 60 + minutes;
}

interface OpeningWindow {
  /** Minutes after local midnight. */
  openMinutes: number;
  /** Minutes after local midnight, with the closing buffer already applied. */
  lastBookableMinutes: number;
}

/** Bookable window for one day's hours once the closing buffer is applied. Throws if there isn't one. */
function windowFor(dayHours: DayHours, hours: CallbackHours): OpeningWindow {
  const openMinutes = parseHhMm(dayHours.open);
  const lastBookableMinutes = parseHhMm(dayHours.close) - hours.closingBufferMinutes;
  if (lastBookableMinutes <= openMinutes) {
    throw new Error(
      `Callback hours ${dayHours.open}-${dayHours.close} leave no bookable time after a ` +
        `${hours.closingBufferMinutes} minute closing buffer`,
    );
  }
  return { openMinutes, lastBookableMinutes };
}

/** Effective bookable window on a local date, or undefined if closed that day. */
function windowOn(date: LocalDate, hours: CallbackHours): OpeningWindow | undefined {
  if (hours.closedDates.includes(toIsoDate(date))) return undefined;

  const dayHours = hours.weekly[weekdayOf(date) as Weekday];
  if (!dayHours) return undefined;

  return windowFor(dayHours, hours);
}

/**
 * Checks a hours table is usable: every open day has well-formed times and some bookable
 * time after the closing buffer, and at least one day is open. Throws describing the
 * first problem. Call this when loading configuration so mistakes surface at startup.
 */
export function validateCallbackHours(hours: CallbackHours): void {
  const openDays = Object.values(hours.weekly).filter((d): d is DayHours => d !== undefined);
  if (openDays.length === 0) {
    throw new Error("Callback hours must have at least one open day");
  }
  for (const dayHours of openDays) {
    windowFor(dayHours, hours);
  }
}

/** True if a callback may be scheduled at `instant`: the centre is open and not about to close. */
export function isOpenAt(instant: Date, hours: CallbackHours): boolean {
  const local = toLocalDateTime(instant, hours.timeZone);
  const window = windowOn(local, hours);
  if (!window) return false;

  const minutesOfDay = local.hour * 60 + local.minute;
  return minutesOfDay >= window.openMinutes && minutesOfDay < window.lastBookableMinutes;
}

/** Upper bound on the search so a misconfigured (always closed) table fails loudly. */
const MAX_DAYS_TO_SEARCH = 366;

/**
 * The earliest instant at or after `from` when a callback may be scheduled.
 * Returns `from` itself if we're open then.
 */
export function nextOpening(from: Date, hours: CallbackHours): Date {
  if (isOpenAt(from, hours)) return from;

  const startDate = toLocalDateTime(from, hours.timeZone);
  for (let offset = 0; offset < MAX_DAYS_TO_SEARCH; offset++) {
    const date = addDays(startDate, offset);
    const window = windowOn(date, hours);
    if (!window) continue;

    const opensAt = fromLocalDateTime(
      {
        ...date,
        hour: Math.floor(window.openMinutes / 60),
        minute: window.openMinutes % 60,
        second: 0,
      },
      hours.timeZone,
    );
    // On the first day, `from` may already be past opening (we're in or after the
    // closing buffer), in which case today's opening is no use and we move on.
    if (opensAt.getTime() > from.getTime()) return opensAt;
  }

  throw new Error(`No callback opening found within ${MAX_DAYS_TO_SEARCH} days of ${from.toISOString()}`);
}
