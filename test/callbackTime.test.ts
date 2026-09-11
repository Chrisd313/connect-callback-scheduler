import { describe, expect, it } from "vitest";
import { resolveCallbackTime, toSchedulerAtExpression } from "../src/lib/callbackTime.js";

describe("resolveCallbackTime", () => {
  const now = new Date("2026-11-02T10:00:00Z");

  it("uses the preferred time when given", () => {
    const preferred = new Date("2026-11-02T15:00:00Z");
    expect(resolveCallbackTime(now, preferred, 15)).toEqual(preferred);
  });

  it("falls back to now + default delay", () => {
    expect(resolveCallbackTime(now, undefined, 15).toISOString()).toBe("2026-11-02T10:15:00.000Z");
  });
});

describe("toSchedulerAtExpression", () => {
  it("formats as at(...) in UTC without milliseconds or offset", () => {
    expect(toSchedulerAtExpression(new Date("2026-11-02T14:30:45.123Z"))).toBe(
      "at(2026-11-02T14:30:45)",
    );
  });
});
