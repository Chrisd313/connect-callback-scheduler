import { describe, expect, it } from "vitest";
import { isOpenAt, nextOpening, validateCallbackHours, type CallbackHours } from "../src/lib/callbackHours.js";
import {
  DEFAULT_CALLBACK_HOURS,
  ENGLAND_AND_WALES_BANK_HOLIDAYS,
} from "../src/lib/defaultCallbackHours.js";
import { weekdayOf } from "../src/lib/localTime.js";

const hours = DEFAULT_CALLBACK_HOURS;
const utc = (iso: string) => new Date(iso);

// Reference week, all in GMT so local == UTC and the expectations are easy to read:
// Mon 2 Nov 2026 ... Sat 7 Nov ... Sun 8 Nov.

describe("isOpenAt (default UK hours)", () => {
  describe("weekdays 08:00-20:00", () => {
    it.each([
      ["2026-11-02T07:59:59Z", false, "just before opening"],
      ["2026-11-02T08:00:00Z", true, "opening time"],
      ["2026-11-02T12:00:00Z", true, "midday"],
      ["2026-11-02T19:44:59Z", true, "last bookable second"],
      ["2026-11-02T19:45:00Z", false, "start of the 15 minute closing buffer"],
      ["2026-11-02T19:59:59Z", false, "inside the closing buffer"],
      ["2026-11-02T20:00:00Z", false, "closing time"],
      ["2026-11-02T21:40:00Z", false, "evening (the complaint that prompted CCB-142)"],
      ["2026-11-06T19:44:00Z", true, "Friday evening before the buffer"],
    ])("%s -> %s (%s)", (iso, expected) => {
      expect(isOpenAt(utc(iso), hours)).toBe(expected);
    });
  });

  describe("Saturday 09:00-13:00", () => {
    it.each([
      ["2026-11-07T08:59:59Z", false, "just before opening"],
      ["2026-11-07T09:00:00Z", true, "opening time"],
      ["2026-11-07T12:44:59Z", true, "last bookable second"],
      ["2026-11-07T12:45:00Z", false, "start of the closing buffer"],
      ["2026-11-07T13:00:00Z", false, "closing time"],
      ["2026-11-07T15:00:00Z", false, "Saturday afternoon"],
    ])("%s -> %s (%s)", (iso, expected) => {
      expect(isOpenAt(utc(iso), hours)).toBe(expected);
    });
  });

  it("is closed all day Sunday", () => {
    for (const hour of [0, 8, 9, 10, 12, 15, 20, 23]) {
      const iso = `2026-11-08T${String(hour).padStart(2, "0")}:00:00Z`;
      expect(isOpenAt(utc(iso), hours), iso).toBe(false);
    }
  });

  it("is closed on bank holidays even at a time we'd normally be open", () => {
    expect(isOpenAt(utc("2026-05-04T10:00:00Z"), hours)).toBe(false); // Early May BH, Monday, BST
    expect(isOpenAt(utc("2026-12-25T10:00:00Z"), hours)).toBe(false); // Christmas Day, Friday
    expect(isOpenAt(utc("2026-12-28T10:00:00Z"), hours)).toBe(false); // Boxing Day substitute, Monday
    expect(isOpenAt(utc("2027-12-28T10:00:00Z"), hours)).toBe(false); // Boxing Day substitute 2027, Tuesday
  });

  it("is open on the days around a bank holiday", () => {
    expect(isOpenAt(utc("2026-05-01T10:00:00Z"), hours)).toBe(true); // Friday before
    expect(isOpenAt(utc("2026-05-05T10:00:00Z"), hours)).toBe(true); // Tuesday after
    expect(isOpenAt(utc("2026-12-24T10:00:00Z"), hours)).toBe(true); // Christmas Eve
    expect(isOpenAt(utc("2026-12-29T10:00:00Z"), hours)).toBe(true);
  });

  it("evaluates bank holidays as UK local dates", () => {
    // 23:30Z on 31 Aug 2026 is 00:30 BST on 1 Sep, which isn't a holiday.
    // Still closed (it's the middle of the night) but not because of the holiday;
    // what matters is that 07:30Z on 1 Sep (08:30 BST) is open.
    expect(isOpenAt(utc("2026-09-01T07:30:00Z"), hours)).toBe(true);
    // And 08:30 BST on the holiday itself is closed.
    expect(isOpenAt(utc("2026-08-31T07:30:00Z"), hours)).toBe(false);
  });

  describe("BST start (clocks forward Sunday 29 March 2026)", () => {
    it("Friday 27 March (GMT): 08:00 local is 08:00Z", () => {
      expect(isOpenAt(utc("2026-03-27T07:59:00Z"), hours)).toBe(false);
      expect(isOpenAt(utc("2026-03-27T08:00:00Z"), hours)).toBe(true);
      expect(isOpenAt(utc("2026-03-27T19:44:00Z"), hours)).toBe(true);
      expect(isOpenAt(utc("2026-03-27T19:45:00Z"), hours)).toBe(false);
    });

    it("Monday 30 March (BST): 08:00 local is 07:00Z", () => {
      expect(isOpenAt(utc("2026-03-30T06:59:00Z"), hours)).toBe(false);
      expect(isOpenAt(utc("2026-03-30T07:00:00Z"), hours)).toBe(true);
      expect(isOpenAt(utc("2026-03-30T18:44:00Z"), hours)).toBe(true); // 19:44 BST
      expect(isOpenAt(utc("2026-03-30T18:45:00Z"), hours)).toBe(false); // 19:45 BST
      expect(isOpenAt(utc("2026-03-30T19:30:00Z"), hours)).toBe(false); // 20:30 BST; would be open if we forgot BST
    });
  });

  describe("BST end (clocks back Sunday 25 October 2026)", () => {
    it("Friday 23 October (BST): 20:00 local is 19:00Z", () => {
      expect(isOpenAt(utc("2026-10-23T06:59:00Z"), hours)).toBe(false); // 07:59 BST
      expect(isOpenAt(utc("2026-10-23T07:00:00Z"), hours)).toBe(true); // 08:00 BST
      expect(isOpenAt(utc("2026-10-23T18:44:00Z"), hours)).toBe(true); // 19:44 BST
      expect(isOpenAt(utc("2026-10-23T18:45:00Z"), hours)).toBe(false); // 19:45 BST
    });

    it("Monday 26 October (GMT): 08:00 local is 08:00Z", () => {
      expect(isOpenAt(utc("2026-10-26T07:00:00Z"), hours)).toBe(false); // 07:00 GMT; would be open if we still applied BST
      expect(isOpenAt(utc("2026-10-26T08:00:00Z"), hours)).toBe(true);
      expect(isOpenAt(utc("2026-10-26T19:44:00Z"), hours)).toBe(true);
      expect(isOpenAt(utc("2026-10-26T19:45:00Z"), hours)).toBe(false);
    });
  });
});

describe("nextOpening (default UK hours)", () => {
  it("returns the same instant when already open", () => {
    const when = utc("2026-11-02T10:00:00Z");
    expect(nextOpening(when, hours)).toBe(when);
  });

  it("early on a weekday morning -> 08:00 that day", () => {
    expect(nextOpening(utc("2026-11-02T06:30:00Z"), hours).toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("in the closing buffer -> 08:00 next day", () => {
    expect(nextOpening(utc("2026-11-02T19:50:00Z"), hours).toISOString()).toBe("2026-11-03T08:00:00.000Z");
  });

  it("late weekday evening -> 08:00 next day", () => {
    expect(nextOpening(utc("2026-11-02T21:40:00Z"), hours).toISOString()).toBe("2026-11-03T08:00:00.000Z");
  });

  it("Friday evening -> Saturday 09:00", () => {
    expect(nextOpening(utc("2026-11-06T20:30:00Z"), hours).toISOString()).toBe("2026-11-07T09:00:00.000Z");
  });

  it("Saturday after the buffer -> Monday 08:00, skipping Sunday", () => {
    expect(nextOpening(utc("2026-11-07T12:50:00Z"), hours).toISOString()).toBe("2026-11-09T08:00:00.000Z");
  });

  it("Sunday morning -> Monday 08:00", () => {
    expect(nextOpening(utc("2026-11-08T09:00:00Z"), hours).toISOString()).toBe("2026-11-09T08:00:00.000Z");
  });

  it("skips bank holidays", () => {
    // Friday 1 May 2026 evening: Sat 2 May open, so Saturday 09:00 BST
    expect(nextOpening(utc("2026-05-01T19:00:00Z"), hours).toISOString()).toBe("2026-05-02T08:00:00.000Z");
    // Saturday 2 May after close: Sunday closed, Monday 4 May is a bank holiday -> Tuesday 08:00 BST
    expect(nextOpening(utc("2026-05-02T12:00:00Z"), hours).toISOString()).toBe("2026-05-05T07:00:00.000Z");
  });

  it("skips a run of consecutive closed days (Easter weekend + Christmas)", () => {
    // Thursday 2 April 2026 evening -> Good Friday closed -> Saturday 4 April 09:00 BST
    expect(nextOpening(utc("2026-04-02T19:30:00Z"), hours).toISOString()).toBe("2026-04-04T08:00:00.000Z");
    // Saturday 4 April after close -> Sunday, Easter Monday closed -> Tuesday 7 April 08:00 BST
    expect(nextOpening(utc("2026-04-04T12:00:00Z"), hours).toISOString()).toBe("2026-04-07T07:00:00.000Z");
    // Saturday 25 December 2027 after close -> Sunday, then Mon 27 & Tue 28 are substitute bank holidays
    // -> Wednesday 29 December 2027 08:00 GMT
    expect(nextOpening(utc("2027-12-25T13:00:00Z"), hours).toISOString()).toBe("2027-12-29T08:00:00.000Z");
  });

  describe("across BST start", () => {
    it("Saturday 28 March 2026 (GMT) afternoon -> Monday 30 March 08:00 BST = 07:00Z", () => {
      expect(nextOpening(utc("2026-03-28T12:50:00Z"), hours).toISOString()).toBe("2026-03-30T07:00:00.000Z");
    });

    it("Friday 27 March 2026 evening -> Saturday 28 March 09:00 GMT = 09:00Z (change hasn't happened yet)", () => {
      expect(nextOpening(utc("2026-03-27T19:50:00Z"), hours).toISOString()).toBe("2026-03-28T09:00:00.000Z");
    });

    it("Sunday 29 March 2026 (the change day) -> Monday 08:00 BST = 07:00Z", () => {
      expect(nextOpening(utc("2026-03-29T10:00:00Z"), hours).toISOString()).toBe("2026-03-30T07:00:00.000Z");
    });

    it("2027 too: Saturday 27 March 2027 -> Monday 29 March is Easter Monday -> Tuesday 30 March 07:00Z", () => {
      expect(nextOpening(utc("2027-03-27T13:00:00Z"), hours).toISOString()).toBe("2027-03-30T07:00:00.000Z");
    });
  });

  describe("across BST end", () => {
    it("Saturday 24 October 2026 (BST) afternoon -> Monday 26 October 08:00 GMT = 08:00Z", () => {
      expect(nextOpening(utc("2026-10-24T12:00:00Z"), hours).toISOString()).toBe("2026-10-26T08:00:00.000Z");
    });

    it("Friday 23 October 2026 evening -> Saturday 24 October 09:00 BST = 08:00Z", () => {
      expect(nextOpening(utc("2026-10-23T19:00:00Z"), hours).toISOString()).toBe("2026-10-24T08:00:00.000Z");
    });

    it("Sunday 25 October 2026 (the change day) -> Monday 08:00 GMT = 08:00Z", () => {
      expect(nextOpening(utc("2026-10-25T10:00:00Z"), hours).toISOString()).toBe("2026-10-26T08:00:00.000Z");
    });

    it("2027 too: Saturday 30 October 2027 -> Monday 1 November 08:00 GMT = 08:00Z", () => {
      expect(nextOpening(utc("2027-10-30T13:00:00Z"), hours).toISOString()).toBe("2027-11-01T08:00:00.000Z");
    });
  });
});

describe("hours are configuration, not code", () => {
  it("extending Saturday hours only needs a data change", () => {
    const extended: CallbackHours = {
      ...hours,
      weekly: { ...hours.weekly, 6: { open: "09:00", close: "17:00" } },
    };
    const saturdayAfternoon = utc("2026-11-07T15:00:00Z");
    expect(isOpenAt(saturdayAfternoon, hours)).toBe(false);
    expect(isOpenAt(saturdayAfternoon, extended)).toBe(true);
  });

  it("opening on Sunday only needs a data change", () => {
    const sevenDays: CallbackHours = {
      ...hours,
      weekly: { ...hours.weekly, 0: { open: "10:00", close: "16:00" } },
    };
    expect(nextOpening(utc("2026-11-07T13:00:00Z"), sevenDays).toISOString()).toBe("2026-11-08T10:00:00.000Z");
  });

  it("supports a different closing buffer", () => {
    const noBuffer: CallbackHours = { ...hours, closingBufferMinutes: 0 };
    expect(isOpenAt(utc("2026-11-02T19:59:00Z"), noBuffer)).toBe(true);
    expect(isOpenAt(utc("2026-11-02T20:00:00Z"), noBuffer)).toBe(false);
  });

  it("rejects malformed times rather than silently treating them as closed", () => {
    const bad: CallbackHours = { ...hours, weekly: { 1: { open: "8am", close: "20:00" } } };
    expect(() => isOpenAt(utc("2026-11-02T10:00:00Z"), bad)).toThrow(/HH:MM/);
  });

  it("rejects hours the closing buffer would swallow entirely", () => {
    const tiny: CallbackHours = { ...hours, weekly: { 1: { open: "08:00", close: "08:10" } } };
    expect(() => isOpenAt(utc("2026-11-02T08:05:00Z"), tiny)).toThrow(/closing buffer/);
  });

  it("fails loudly if there is never an opening", () => {
    const alwaysClosed: CallbackHours = { ...hours, weekly: {} };
    expect(() => nextOpening(utc("2026-11-02T10:00:00Z"), alwaysClosed)).toThrow(/No callback opening/);
  });
});

describe("validateCallbackHours", () => {
  it("accepts the default table", () => {
    expect(() => validateCallbackHours(hours)).not.toThrow();
  });

  it("rejects a table with no open days", () => {
    expect(() => validateCallbackHours({ ...hours, weekly: {} })).toThrow(/at least one open day/);
  });

  it("checks every open day, not just the first", () => {
    const badFriday: CallbackHours = { ...hours, weekly: { ...hours.weekly, 5: { open: "08:00", close: "08:10" } } };
    expect(() => validateCallbackHours(badFriday)).toThrow(/closing buffer/);
  });

  it("rejects malformed times", () => {
    expect(() => validateCallbackHours({ ...hours, weekly: { 1: { open: "8", close: "20:00" } } })).toThrow(/HH:MM/);
  });
});

describe("ENGLAND_AND_WALES_BANK_HOLIDAYS", () => {
  it("covers 2026 and 2027 with eight holidays each", () => {
    expect(ENGLAND_AND_WALES_BANK_HOLIDAYS.filter((d) => d.startsWith("2026-"))).toHaveLength(8);
    expect(ENGLAND_AND_WALES_BANK_HOLIDAYS.filter((d) => d.startsWith("2027-"))).toHaveLength(8);
  });

  it("never lists a weekend day (bank holidays that clash with a weekend move to a weekday)", () => {
    for (const iso of ENGLAND_AND_WALES_BANK_HOLIDAYS) {
      const [year, month, day] = iso.split("-").map(Number);
      const weekday = weekdayOf({ year, month, day });
      expect(weekday, iso).not.toBe(0);
      expect(weekday, iso).not.toBe(6);
    }
  });

  it("is sorted and free of duplicates", () => {
    const sorted = [...ENGLAND_AND_WALES_BANK_HOLIDAYS].sort();
    expect(ENGLAND_AND_WALES_BANK_HOLIDAYS).toEqual(sorted);
    expect(new Set(ENGLAND_AND_WALES_BANK_HOLIDAYS).size).toBe(ENGLAND_AND_WALES_BANK_HOLIDAYS.length);
  });
});
