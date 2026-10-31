import { describe, expect, it } from "vitest";
import { isOpenAt, nextOpening } from "../src/lib/callbackHours.js";
import {
  CallbackHoursConfigError,
  callbackHoursFromEnv,
  parseClosedDates,
  parseWeeklyHours,
} from "../src/lib/callbackHoursConfig.js";
import { DEFAULT_CALLBACK_HOURS } from "../src/lib/defaultCallbackHours.js";

const WEEKDAY = { open: "08:00", close: "20:00" };
const SATURDAY = { open: "09:00", close: "13:00" };

describe("parseWeeklyHours", () => {
  it("parses the production hours spec into the same table as the code default", () => {
    expect(parseWeeklyHours("mon-fri=08:00-20:00,sat=09:00-13:00")).toEqual(DEFAULT_CALLBACK_HOURS.weekly);
  });

  it("accepts single days, ranges, mixed case and surrounding whitespace", () => {
    expect(parseWeeklyHours(" Mon = 08:00-20:00 , TUE-Thu=09:00-17:00 ,sat=09:00-13:00, ")).toEqual({
      1: WEEKDAY,
      2: { open: "09:00", close: "17:00" },
      3: { open: "09:00", close: "17:00" },
      4: { open: "09:00", close: "17:00" },
      6: SATURDAY,
    });
  });

  it("wraps a range that runs past Sunday", () => {
    expect(Object.keys(parseWeeklyHours("fri-mon=10:00-16:00")).map(Number).sort()).toEqual([0, 1, 5, 6]);
  });

  it("leaves unlisted days closed", () => {
    expect(parseWeeklyHours("sat=09:00-13:00")).toEqual({ 6: SATURDAY });
  });

  it.each([
    ["mon-fri", /must look like/],
    ["mon-fri=8am-8pm", /HH:MM-HH:MM/],
    ["mon-fri=08:00-24:00", /HH:MM-HH:MM/],
    ["mon-fri=08:00-20:00-21:00", /HH:MM-HH:MM/],
    ["mon-fri=20:00-08:00", /closing time must be after/],
    ["mon-fri=08:00-08:00", /closing time must be after/],
    ["monday=08:00-20:00", /unknown day "monday"/],
    ["mon-wed-fri=08:00-20:00", /bad day range/],
    ["mon-fri=08:00-20:00,wed=09:00-17:00", /wed is listed more than once/],
    ["", /no opening hours/],
    [" , ", /no opening hours/],
  ])("rejects %j", (spec, message) => {
    expect(() => parseWeeklyHours(spec)).toThrow(CallbackHoursConfigError);
    expect(() => parseWeeklyHours(spec)).toThrow(message);
  });

  it("names the variable in the error so it's findable in the template", () => {
    expect(() => parseWeeklyHours("nope")).toThrow(/^Invalid CALLBACK_HOURS:/);
  });
});

describe("parseClosedDates", () => {
  it("parses a comma-separated list", () => {
    expect(parseClosedDates("2026-01-01,2026-04-03")).toEqual(["2026-01-01", "2026-04-03"]);
  });

  it("tolerates whitespace and newlines (as pasted from gov.uk or a YAML block)", () => {
    expect(parseClosedDates(" 2026-01-01,\n  2026-04-03 ,2026-04-06\n")).toEqual([
      "2026-01-01",
      "2026-04-03",
      "2026-04-06",
    ]);
  });

  it("sorts and de-duplicates", () => {
    expect(parseClosedDates("2026-04-03,2026-01-01,2026-04-03")).toEqual(["2026-01-01", "2026-04-03"]);
  });

  it.each([
    ["01/01/2026", /not a YYYY-MM-DD date/],
    ["2026-1-1", /not a YYYY-MM-DD date/],
    ["20260101", /not a YYYY-MM-DD date/],
    ["2026-02-30", /not a real calendar date/],
    ["2026-13-01", /not a real calendar date/],
    ["2027-02-29", /not a real calendar date/],
  ])("rejects %s", (spec, message) => {
    expect(() => parseClosedDates(spec)).toThrow(CallbackHoursConfigError);
    expect(() => parseClosedDates(spec)).toThrow(message);
  });

  it("accepts a leap day in a leap year", () => {
    expect(parseClosedDates("2028-02-29")).toEqual(["2028-02-29"]);
  });
});

describe("callbackHoursFromEnv", () => {
  it("returns the code defaults when nothing is set", () => {
    expect(callbackHoursFromEnv({})).toEqual(DEFAULT_CALLBACK_HOURS);
  });

  it("treats empty or whitespace-only variables as unset", () => {
    expect(
      callbackHoursFromEnv({
        CALLBACK_HOURS: "",
        CALLBACK_CLOSED_DATES: "  ",
        CALLBACK_TIMEZONE: "",
        CALLBACK_CLOSING_BUFFER_MINUTES: "",
      }),
    ).toEqual(DEFAULT_CALLBACK_HOURS);
  });

  it("overrides only the variables that are set", () => {
    const hours = callbackHoursFromEnv({ CALLBACK_HOURS: "mon-fri=08:00-20:00,sat=09:00-17:00" });
    expect(hours.weekly[6]).toEqual({ open: "09:00", close: "17:00" });
    expect(hours.weekly[1]).toEqual(WEEKDAY);
    expect(hours.closedDates).toBe(DEFAULT_CALLBACK_HOURS.closedDates);
    expect(hours.timeZone).toBe("Europe/London");
    expect(hours.closingBufferMinutes).toBe(15);
  });

  it("extending Saturdays via the environment changes scheduling with no code change", () => {
    const extended = callbackHoursFromEnv({ CALLBACK_HOURS: "mon-fri=08:00-20:00,sat=09:00-17:00" });
    const saturdayAfternoon = new Date("2026-11-07T15:00:00Z");
    expect(isOpenAt(saturdayAfternoon, DEFAULT_CALLBACK_HOURS)).toBe(false);
    expect(isOpenAt(saturdayAfternoon, extended)).toBe(true);
  });

  it("replacing the closed dates replaces the whole list (the yearly bank holiday update)", () => {
    const hours = callbackHoursFromEnv({ CALLBACK_CLOSED_DATES: "2028-01-03,2028-04-14" });
    expect(hours.closedDates).toEqual(["2028-01-03", "2028-04-14"]);
    // 2026 holidays are no longer in the list, so Early May 2026 is a normal Monday
    expect(isOpenAt(new Date("2026-05-04T10:00:00Z"), hours)).toBe(true);
    // and the 2028 date is closed: Monday 3 Jan 2028 -> Tuesday 4 Jan 08:00 GMT
    expect(nextOpening(new Date("2028-01-03T10:00:00Z"), hours).toISOString()).toBe("2028-01-04T08:00:00.000Z");
  });

  it("accepts a different time zone and closing buffer", () => {
    const hours = callbackHoursFromEnv({ CALLBACK_TIMEZONE: "Europe/Dublin", CALLBACK_CLOSING_BUFFER_MINUTES: "30" });
    expect(hours.timeZone).toBe("Europe/Dublin");
    expect(hours.closingBufferMinutes).toBe(30);
    expect(isOpenAt(new Date("2026-11-02T19:35:00Z"), hours)).toBe(false); // inside a 30 minute buffer
    expect(isOpenAt(new Date("2026-11-02T19:25:00Z"), hours)).toBe(true);
  });

  it("accepts a zero closing buffer", () => {
    expect(callbackHoursFromEnv({ CALLBACK_CLOSING_BUFFER_MINUTES: "0" }).closingBufferMinutes).toBe(0);
  });

  it.each([
    [{ CALLBACK_TIMEZONE: "Europe/Londno" }, /CALLBACK_TIMEZONE.*not a recognised IANA time zone/],
    [{ CALLBACK_TIMEZONE: "GMT+1" }, /CALLBACK_TIMEZONE/],
    [{ CALLBACK_CLOSING_BUFFER_MINUTES: "fifteen" }, /CALLBACK_CLOSING_BUFFER_MINUTES.*whole number/],
    [{ CALLBACK_CLOSING_BUFFER_MINUTES: "-5" }, /CALLBACK_CLOSING_BUFFER_MINUTES.*0 or more/],
    [{ CALLBACK_CLOSING_BUFFER_MINUTES: "7.5" }, /CALLBACK_CLOSING_BUFFER_MINUTES.*whole number/],
    [{ CALLBACK_HOURS: "mon=08:00-20:00,mon=09:00-17:00" }, /CALLBACK_HOURS.*more than once/],
    [{ CALLBACK_CLOSED_DATES: "2026-01-01;2026-04-03" }, /CALLBACK_CLOSED_DATES/],
  ])("rejects %j at load time", (env, message) => {
    expect(() => callbackHoursFromEnv(env)).toThrow(CallbackHoursConfigError);
    expect(() => callbackHoursFromEnv(env)).toThrow(message);
  });

  it("rejects a closing buffer that swallows a whole day's hours", () => {
    // Saturday is only 4 hours
    expect(() => callbackHoursFromEnv({ CALLBACK_CLOSING_BUFFER_MINUTES: "240" })).toThrow(/closing buffer/);
  });

  it("does not read process.env when an explicit environment is given", () => {
    process.env.CALLBACK_HOURS = "sun=10:00-16:00";
    try {
      expect(callbackHoursFromEnv({}).weekly[0]).toBeUndefined();
    } finally {
      delete process.env.CALLBACK_HOURS;
    }
  });
});
