import { describe, expect, it } from "vitest";
import { normaliseUkPhoneNumber, parsePreferredTime, ValidationError } from "../src/lib/validation.js";

describe("normaliseUkPhoneNumber", () => {
  it.each([
    ["+447700900123", "+447700900123"],
    ["07700 900123", "+447700900123"],
    ["(0161) 496 0000", "+441614960000"],
    ["00447700900123", "+447700900123"],
    ["447700900123", "+447700900123"],
  ])("normalises %s", (input, expected) => {
    expect(normaliseUkPhoneNumber(input)).toBe(expected);
  });

  it.each(["", "12345", "+15551234567", "+4407700900123", "0770090"])(
    "rejects %s",
    (input) => {
      expect(() => normaliseUkPhoneNumber(input)).toThrow(ValidationError);
    },
  );
});

describe("parsePreferredTime", () => {
  const now = new Date("2026-11-02T10:00:00Z");

  it("returns undefined when not provided", () => {
    expect(parsePreferredTime(undefined, now)).toBeUndefined();
    expect(parsePreferredTime("  ", now)).toBeUndefined();
  });

  it("parses an ISO timestamp with offset", () => {
    expect(parsePreferredTime("2026-11-02T14:30:00+00:00", now)?.toISOString()).toBe(
      "2026-11-02T14:30:00.000Z",
    );
  });

  it("rejects garbage", () => {
    expect(() => parsePreferredTime("tomorrow afternoon", now)).toThrow(ValidationError);
  });

  it("rejects times in the past", () => {
    expect(() => parsePreferredTime("2026-11-02T09:00:00Z", now)).toThrow(/future/);
  });
});
