/**
 * Time zone helpers built on Intl so we don't need a date library in the Lambda bundle.
 *
 * Everything here is explicit about the zone it operates in. Nothing depends on the
 * process TZ, which is UTC on Lambda and whatever the developer happens to have locally.
 */

export interface LocalDateTime {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** 0-23 */
  hour: number;
  minute: number;
  second: number;
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      // h23 rather than hour12:false, which some ICU versions render midnight as "24".
      hourCycle: "h23",
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock date and time of `instant` in `timeZone`. */
export function toLocalDateTime(instant: Date, timeZone: string): LocalDateTime {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl did not return a "${type}" part for time zone ${timeZone}`);
    return Number(part.value);
  };
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (positive = ahead of UTC). */
function utcOffsetMs(instant: Date, timeZone: string): number {
  const local = toLocalDateTime(instant, timeZone);
  const asIfUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  // Intl drops sub-second precision, so compare against the instant floored to the second.
  const instantSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return asIfUtc - instantSeconds;
}

/**
 * The UTC instant at which `timeZone` wall clocks read the given local date and time.
 *
 * Handles DST: the zone offset is looked up at a first guess and then re-checked at the
 * corrected instant, so local times either side of a clock change resolve correctly.
 *
 * Local times that don't exist (spring-forward gap) or exist twice (autumn overlap) are
 * resolved to a valid instant deterministically, but which one is not something callers
 * should rely on. This never arises for UK callback hours: the UK changes clocks at
 * 01:00 UTC, hours away from any opening or closing time.
 */
export function fromLocalDateTime(local: LocalDateTime, timeZone: string): Date {
  const asIfUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const firstGuess = asIfUtc - utcOffsetMs(new Date(asIfUtc), timeZone);
  const corrected = asIfUtc - utcOffsetMs(new Date(firstGuess), timeZone);
  // If the two disagree we're inside a spring-forward gap; take the later instant,
  // i.e. shift forward by the length of the gap.
  return new Date(Math.max(firstGuess, corrected));
}

/** 0 = Sunday ... 6 = Saturday, for a calendar date (time zone independent). */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Calendar date `days` after `date`. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** `YYYY-MM-DD`, for matching against closed-date lists. */
export function toIsoDate(date: LocalDate): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/**
 * Human-friendly local time for text-to-speech in the contact flow,
 * e.g. "Monday 2 November at 08:00". Year is omitted as callbacks are booked
 * at most a week ahead.
 */
export function formatForReadback(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  // Assemble explicitly rather than relying on the locale's literal separators, so the
  // output stays stable across ICU versions.
  return `${get("weekday")} ${get("day")} ${get("month")} at ${get("hour")}:${get("minute")}`;
}
