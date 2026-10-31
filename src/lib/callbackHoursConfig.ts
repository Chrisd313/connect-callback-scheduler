import type { CallbackHours, DayHours, Weekday } from "./callbackHours.js";
import { validateCallbackHours } from "./callbackHours.js";
import { DEFAULT_CALLBACK_HOURS } from "./defaultCallbackHours.js";

/**
 * Builds the callback hours table from environment variables so ops can change hours
 * or add next year's bank holidays with a deploy parameter rather than a code change.
 *
 * Any variable that is unset or empty falls back to the code default, so an
 * environment that sets nothing behaves exactly like DEFAULT_CALLBACK_HOURS.
 *
 *   CALLBACK_HOURS                  "mon-fri=08:00-20:00,sat=09:00-13:00"  (days not listed are closed)
 *   CALLBACK_CLOSED_DATES           "2026-01-01,2026-04-03,..."           (replaces the default list)
 *   CALLBACK_TIMEZONE               "Europe/London"
 *   CALLBACK_CLOSING_BUFFER_MINUTES "15"
 */
export const CallbackHoursEnv = {
  HOURS: "CALLBACK_HOURS",
  CLOSED_DATES: "CALLBACK_CLOSED_DATES",
  TIMEZONE: "CALLBACK_TIMEZONE",
  CLOSING_BUFFER_MINUTES: "CALLBACK_CLOSING_BUFFER_MINUTES",
} as const;

export class CallbackHoursConfigError extends Error {
  constructor(variable: string, detail: string) {
    super(`Invalid ${variable}: ${detail}`);
    this.name = "CallbackHoursConfigError";
  }
}

const DAY_NAMES: Record<string, Weekday> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayFromName(name: string, variable: string): Weekday {
  const day = DAY_NAMES[name.toLowerCase()];
  if (day === undefined) {
    throw new CallbackHoursConfigError(
      variable,
      `unknown day "${name}" (expected one of ${Object.keys(DAY_NAMES).join(", ")})`,
    );
  }
  return day;
}

/** Expands "mon", "mon-fri" or "sat-mon" (wrapping past Sunday) into weekday numbers. */
function expandDays(spec: string, variable: string): Weekday[] {
  const [first, last, ...rest] = spec.split("-");
  if (rest.length > 0 || first === undefined || first === "") {
    throw new CallbackHoursConfigError(variable, `bad day range "${spec}"`);
  }
  const start = dayFromName(first, variable);
  if (last === undefined) return [start];

  const end = dayFromName(last, variable);
  const days: Weekday[] = [];
  for (let day = start; ; day = ((day + 1) % 7) as Weekday) {
    days.push(day);
    if (day === end) break;
  }
  return days;
}

function parseTimeRange(spec: string, variable: string): DayHours {
  const [open, close, ...rest] = spec.split("-");
  if (rest.length > 0 || open === undefined || close === undefined || !HH_MM.test(open) || !HH_MM.test(close)) {
    throw new CallbackHoursConfigError(variable, `bad time range "${spec}" (expected HH:MM-HH:MM)`);
  }
  if (close <= open) {
    // HH:MM strings compare correctly as text
    throw new CallbackHoursConfigError(variable, `closing time must be after opening time in "${spec}"`);
  }
  return { open, close };
}

/**
 * Parses a weekly hours spec such as "mon-fri=08:00-20:00,sat=09:00-13:00".
 * Entries are comma separated; each is a day or day range, "=", and an HH:MM-HH:MM range.
 */
export function parseWeeklyHours(
  spec: string,
  variable: string = CallbackHoursEnv.HOURS,
): Partial<Record<Weekday, DayHours>> {
  const weekly: Partial<Record<Weekday, DayHours>> = {};

  for (const rawEntry of spec.split(",")) {
    const entry = rawEntry.trim();
    if (entry === "") continue;

    const eq = entry.indexOf("=");
    if (eq === -1) {
      throw new CallbackHoursConfigError(variable, `entry "${entry}" must look like "mon-fri=08:00-20:00"`);
    }
    const days = expandDays(entry.slice(0, eq).trim(), variable);
    const hours = parseTimeRange(entry.slice(eq + 1).trim(), variable);

    for (const day of days) {
      if (weekly[day]) {
        const name = Object.keys(DAY_NAMES).find((k) => DAY_NAMES[k] === day);
        throw new CallbackHoursConfigError(variable, `${name} is listed more than once`);
      }
      weekly[day] = hours;
    }
  }

  if (Object.keys(weekly).length === 0) {
    throw new CallbackHoursConfigError(variable, "no opening hours given");
  }
  return weekly;
}

/** Parses "2026-01-01,2026-04-03" (commas and/or whitespace) into a sorted, de-duplicated list. */
export function parseClosedDates(spec: string, variable: string = CallbackHoursEnv.CLOSED_DATES): string[] {
  const dates = new Set<string>();

  for (const token of spec.split(/[\s,]+/)) {
    if (token === "") continue;
    const match = ISO_DATE.exec(token);
    if (!match) {
      throw new CallbackHoursConfigError(variable, `"${token}" is not a YYYY-MM-DD date`);
    }
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const probe = new Date(Date.UTC(year, month - 1, day));
    const isRealDate =
      probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
    if (!isRealDate) {
      throw new CallbackHoursConfigError(variable, `"${token}" is not a real calendar date`);
    }
    dates.add(token);
  }

  return [...dates].sort();
}

function parseTimeZone(value: string, variable: string): string {
  try {
    // Intl throws RangeError for unknown zones; it's the same check the runtime will make.
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
  } catch {
    throw new CallbackHoursConfigError(variable, `"${value}" is not a recognised IANA time zone`);
  }
  return value;
}

function parseBufferMinutes(value: string, variable: string): number {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new CallbackHoursConfigError(variable, `"${value}" must be a whole number of minutes, 0 or more`);
  }
  return minutes;
}

function setOrUndefined(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}

/**
 * Callback hours for this deployment: environment overrides layered over `defaults`.
 * Throws CallbackHoursConfigError on any malformed value so misconfiguration is caught
 * at cold start rather than producing silently wrong schedules.
 */
export function callbackHoursFromEnv(
  env: Record<string, string | undefined> = process.env,
  defaults: CallbackHours = DEFAULT_CALLBACK_HOURS,
): CallbackHours {
  const hoursSpec = setOrUndefined(env, CallbackHoursEnv.HOURS);
  const closedSpec = setOrUndefined(env, CallbackHoursEnv.CLOSED_DATES);
  const timeZone = setOrUndefined(env, CallbackHoursEnv.TIMEZONE);
  const buffer = setOrUndefined(env, CallbackHoursEnv.CLOSING_BUFFER_MINUTES);

  const hours: CallbackHours = {
    timeZone: timeZone ? parseTimeZone(timeZone, CallbackHoursEnv.TIMEZONE) : defaults.timeZone,
    weekly: hoursSpec ? parseWeeklyHours(hoursSpec, CallbackHoursEnv.HOURS) : defaults.weekly,
    closedDates: closedSpec ? parseClosedDates(closedSpec, CallbackHoursEnv.CLOSED_DATES) : defaults.closedDates,
    closingBufferMinutes: buffer
      ? parseBufferMinutes(buffer, CallbackHoursEnv.CLOSING_BUFFER_MINUTES)
      : defaults.closingBufferMinutes,
  };

  // Cross-field check: the buffer must leave bookable time on every open day.
  validateCallbackHours(hours);
  return hours;
}
