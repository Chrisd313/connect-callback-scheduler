import { describe, expect, it } from "vitest";
import {
  addDays,
  formatForReadback,
  fromLocalDateTime,
  toIsoDate,
  toLocalDateTime,
  weekdayOf,
} from "../src/lib/localTime.js";

const LONDON = "Europe/London";

describe("toLocalDateTime", () => {
  it("reads UK wall-clock time in winter (GMT = UTC)", () => {
    expect(toLocalDateTime(new Date("2026-11-02T08:00:00Z"), LONDON)).toEqual({
      year: 2026,
      month: 11,
      day: 2,
      hour: 8,
      minute: 0,
      second: 0,
    });
  });

  it("reads UK wall-clock time in summer (BST = UTC+1)", () => {
    expect(toLocalDateTime(new Date("2026-07-01T07:00:00Z"), LONDON)).toEqual({
      year: 2026,
      month: 7,
      day: 1,
      hour: 8,
      minute: 0,
      second: 0,
    });
  });

  it("renders midnight as hour 0, not 24", () => {
    expect(toLocalDateTime(new Date("2026-11-02T00:00:00Z"), LONDON).hour).toBe(0);
    // 23:00Z in summer is midnight BST the next day
    const summerMidnight = toLocalDateTime(new Date("2026-06-30T23:00:00Z"), LONDON);
    expect(summerMidnight).toMatchObject({ month: 7, day: 1, hour: 0 });
  });

  it("is not affected by the process time zone", () => {
    // Asia/Tokyo is UTC+9 with no DST; if we accidentally used the process zone the hour would differ.
    expect(toLocalDateTime(new Date("2026-11-02T08:00:00Z"), "Asia/Tokyo").hour).toBe(17);
  });
});

describe("fromLocalDateTime", () => {
  const at = (y: number, m: number, d: number, h: number, min = 0) =>
    fromLocalDateTime({ year: y, month: m, day: d, hour: h, minute: min, second: 0 }, LONDON);

  it("converts a winter local time (GMT)", () => {
    expect(at(2026, 11, 2, 8).toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("converts a summer local time (BST)", () => {
    expect(at(2026, 7, 1, 8).toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(at(2026, 7, 1, 20).toISOString()).toBe("2026-07-01T19:00:00.000Z");
  });

  describe("around BST start (Sunday 29 March 2026, 01:00Z clocks go forward to 02:00)", () => {
    it("Saturday 28 March is still GMT", () => {
      expect(at(2026, 3, 28, 9).toISOString()).toBe("2026-03-28T09:00:00.000Z");
      expect(at(2026, 3, 28, 13).toISOString()).toBe("2026-03-28T13:00:00.000Z");
    });

    it("Monday 30 March is BST", () => {
      expect(at(2026, 3, 30, 8).toISOString()).toBe("2026-03-30T07:00:00.000Z");
      expect(at(2026, 3, 30, 20).toISOString()).toBe("2026-03-30T19:00:00.000Z");
    });

    it("times on the change day itself resolve on the right side of the transition", () => {
      expect(at(2026, 3, 29, 0, 30).toISOString()).toBe("2026-03-29T00:30:00.000Z"); // GMT
      expect(at(2026, 3, 29, 2, 30).toISOString()).toBe("2026-03-29T01:30:00.000Z"); // BST
      expect(at(2026, 3, 29, 8).toISOString()).toBe("2026-03-29T07:00:00.000Z");
    });

    it("a local time in the gap that doesn't exist is shifted forward rather than failing", () => {
      // 01:30 local never happens on 29 March 2026; we resolve it to 02:30 BST.
      expect(at(2026, 3, 29, 1, 30).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    });
  });

  describe("around BST end (Sunday 25 October 2026, 01:00Z clocks go back to 01:00)", () => {
    it("Saturday 24 October is still BST", () => {
      expect(at(2026, 10, 24, 9).toISOString()).toBe("2026-10-24T08:00:00.000Z");
      expect(at(2026, 10, 24, 13).toISOString()).toBe("2026-10-24T12:00:00.000Z");
    });

    it("Monday 26 October is GMT", () => {
      expect(at(2026, 10, 26, 8).toISOString()).toBe("2026-10-26T08:00:00.000Z");
      expect(at(2026, 10, 26, 20).toISOString()).toBe("2026-10-26T20:00:00.000Z");
    });

    it("times on the change day itself resolve on the right side of the transition", () => {
      expect(at(2026, 10, 25, 0, 30).toISOString()).toBe("2026-10-24T23:30:00.000Z"); // BST
      expect(at(2026, 10, 25, 8).toISOString()).toBe("2026-10-25T08:00:00.000Z"); // GMT
    });

    it("an ambiguous local time in the overlap resolves to a real instant", () => {
      // 01:30 local happens twice on 25 October 2026. Either is acceptable; it must be one of them.
      const resolved = at(2026, 10, 25, 1, 30).toISOString();
      expect(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]).toContain(resolved);
    });
  });

  it("round-trips with toLocalDateTime across the year", () => {
    // Every day at 08:00 and 20:00 local for a year; catches any drift around transitions.
    for (let offset = 0; offset < 366; offset++) {
      const date = addDays({ year: 2026, month: 1, day: 1 }, offset);
      for (const hour of [8, 20]) {
        const local = { ...date, hour, minute: 0, second: 0 };
        expect(toLocalDateTime(fromLocalDateTime(local, LONDON), LONDON)).toEqual(local);
      }
    }
  });

  it("works for a zone east of UTC too", () => {
    expect(
      fromLocalDateTime({ year: 2026, month: 11, day: 2, hour: 17, minute: 0, second: 0 }, "Asia/Tokyo").toISOString(),
    ).toBe("2026-11-02T08:00:00.000Z");
  });
});

describe("calendar helpers", () => {
  it("weekdayOf uses 0 = Sunday ... 6 = Saturday", () => {
    expect(weekdayOf({ year: 2026, month: 11, day: 1 })).toBe(0); // Sunday
    expect(weekdayOf({ year: 2026, month: 11, day: 2 })).toBe(1); // Monday
    expect(weekdayOf({ year: 2026, month: 11, day: 7 })).toBe(6); // Saturday
  });

  it("addDays rolls over month and year boundaries", () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addDays({ year: 2026, month: 2, day: 28 }, 1)).toEqual({ year: 2026, month: 3, day: 1 });
    expect(addDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({ year: 2028, month: 2, day: 29 }); // leap year
  });

  it("toIsoDate zero-pads", () => {
    expect(toIsoDate({ year: 2026, month: 1, day: 5 })).toBe("2026-01-05");
  });
});

describe("formatForReadback", () => {
  it("matches the format the contact flow reads out", () => {
    expect(formatForReadback(new Date("2026-11-02T08:00:00Z"), LONDON)).toBe("Monday 2 November at 08:00");
  });

  it("shows UK local time in summer", () => {
    expect(formatForReadback(new Date("2026-07-01T07:00:00Z"), LONDON)).toBe("Wednesday 1 July at 08:00");
  });

  it("uses 24-hour clock with leading zeros and no ordinal suffix", () => {
    expect(formatForReadback(new Date("2026-11-03T19:45:00Z"), LONDON)).toBe("Tuesday 3 November at 19:45");
    expect(formatForReadback(new Date("2026-11-21T09:05:00Z"), LONDON)).toBe("Saturday 21 November at 09:05");
  });
});
