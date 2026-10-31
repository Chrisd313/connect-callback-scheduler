import type { CallbackHours } from "./callbackHours.js";

/**
 * England and Wales bank holidays. Static by design (CCB-142): we don't want a runtime
 * dependency on gov.uk from inside a contact flow. Extend this list each year; the
 * source of truth is https://www.gov.uk/bank-holidays.json ("england-and-wales").
 *
 * When Christmas Day or Boxing Day fall on a weekend the holiday moves to the next
 * weekday(s), which is why the December dates below aren't always the 25th and 26th.
 */
export const ENGLAND_AND_WALES_BANK_HOLIDAYS: readonly string[] = [
  // 2026
  "2026-01-01", // New Year's Day
  "2026-04-03", // Good Friday
  "2026-04-06", // Easter Monday
  "2026-05-04", // Early May bank holiday
  "2026-05-25", // Spring bank holiday
  "2026-08-31", // Summer bank holiday
  "2026-12-25", // Christmas Day
  "2026-12-28", // Boxing Day (substitute day; 26th is a Saturday)
  // 2027
  "2027-01-01", // New Year's Day
  "2027-03-26", // Good Friday
  "2027-03-29", // Easter Monday
  "2027-05-03", // Early May bank holiday
  "2027-05-31", // Spring bank holiday
  "2027-08-30", // Summer bank holiday
  "2027-12-27", // Christmas Day (substitute day; 25th is a Saturday)
  "2027-12-28", // Boxing Day (substitute day; 26th is a Sunday)
];

/**
 * Contact centre callback hours. This is the one place to change if hours move
 * (e.g. extending Saturdays); nothing in the scheduling logic knows these values.
 */
export const DEFAULT_CALLBACK_HOURS: CallbackHours = {
  timeZone: "Europe/London",
  weekly: {
    // Sunday (0): closed
    1: { open: "08:00", close: "20:00" },
    2: { open: "08:00", close: "20:00" },
    3: { open: "08:00", close: "20:00" },
    4: { open: "08:00", close: "20:00" },
    5: { open: "08:00", close: "20:00" },
    6: { open: "09:00", close: "13:00" },
  },
  closedDates: ENGLAND_AND_WALES_BANK_HOLIDAYS,
  closingBufferMinutes: 15,
};
