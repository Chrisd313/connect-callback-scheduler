import { describe, expect, it } from "vitest";
import { CallbackTimeReason, resolveCallbackTime, toSchedulerAtExpression } from "../src/lib/callbackTime.js";
import { DEFAULT_CALLBACK_HOURS } from "../src/lib/defaultCallbackHours.js";
import { ValidationError } from "../src/lib/validation.js";

const utc = (iso: string) => new Date(iso);

function resolve(now: string, preferredTime?: string, overrides: { defaultDelayMinutes?: number; maxDaysAhead?: number } = {}) {
  return resolveCallbackTime({
    now: utc(now),
    preferredTime: preferredTime ? utc(preferredTime) : undefined,
    defaultDelayMinutes: overrides.defaultDelayMinutes ?? 15,
    maxDaysAhead: overrides.maxDaysAhead ?? 7,
    hours: DEFAULT_CALLBACK_HOURS,
  });
}

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return err.code;
    throw err;
  }
  return undefined;
}

describe("resolveCallbackTime without a preferred time", () => {
  it("uses now + default delay during callback hours", () => {
    expect(resolve("2026-11-02T10:00:00Z").toISOString()).toBe("2026-11-02T10:15:00.000Z");
  });

  it("honours a different default delay", () => {
    expect(resolve("2026-11-02T10:00:00Z", undefined, { defaultDelayMinutes: 30 }).toISOString()).toBe(
      "2026-11-02T10:30:00.000Z",
    );
  });

  it("moves to the next opening when now + delay lands before we open", () => {
    // 07:40 + 15 = 07:55, before 08:00
    expect(resolve("2026-11-02T07:40:00Z").toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("keeps now + delay when it lands just after we open", () => {
    // 07:50 + 15 = 08:05
    expect(resolve("2026-11-02T07:50:00Z").toISOString()).toBe("2026-11-02T08:05:00.000Z");
  });

  it("moves to the next day when now + delay lands in the last 15 minutes before close", () => {
    // 19:30 + 15 = 19:45, the start of the closing buffer
    expect(resolve("2026-11-02T19:30:00Z").toISOString()).toBe("2026-11-03T08:00:00.000Z");
  });

  it("keeps now + delay when it lands just before the closing buffer", () => {
    // 19:29 + 15 = 19:44
    expect(resolve("2026-11-02T19:29:00Z").toISOString()).toBe("2026-11-02T19:44:00.000Z");
  });

  it("moves a late-evening request to 08:00 the next morning (the 21:40 complaint)", () => {
    expect(resolve("2026-11-02T21:25:00Z").toISOString()).toBe("2026-11-03T08:00:00.000Z");
  });

  it("moves a Friday evening request to Saturday 09:00", () => {
    expect(resolve("2026-11-06T20:00:00Z").toISOString()).toBe("2026-11-07T09:00:00.000Z");
  });

  it("moves a Saturday afternoon request to Monday 08:00", () => {
    expect(resolve("2026-11-07T12:35:00Z").toISOString()).toBe("2026-11-09T08:00:00.000Z");
  });

  it("moves a Sunday request to Monday 08:00 (the Sunday morning complaint)", () => {
    expect(resolve("2026-11-08T09:30:00Z").toISOString()).toBe("2026-11-09T08:00:00.000Z");
  });

  it("moves a bank holiday request to the next working day", () => {
    // Early May bank holiday, Monday 4 May 2026 (BST) -> Tuesday 08:00 BST
    expect(resolve("2026-05-04T10:00:00Z").toISOString()).toBe("2026-05-05T07:00:00.000Z");
  });

  describe("across the clock changes", () => {
    it("Saturday before BST starts -> Monday 08:00 BST (07:00Z)", () => {
      expect(resolve("2026-03-28T12:45:00Z").toISOString()).toBe("2026-03-30T07:00:00.000Z");
    });

    it("Saturday before BST ends -> Monday 08:00 GMT (08:00Z)", () => {
      expect(resolve("2026-10-24T12:00:00Z").toISOString()).toBe("2026-10-26T08:00:00.000Z");
    });

    it("evening request in BST: 19:30 BST + 15 is in the buffer -> next day 08:00 BST", () => {
      // 18:30Z = 19:30 BST; + 15 = 19:45 BST -> closed
      expect(resolve("2026-07-01T18:30:00Z").toISOString()).toBe("2026-07-02T07:00:00.000Z");
    });
  });
});

describe("resolveCallbackTime with a preferred time", () => {
  it("honours a preferred time inside callback hours and doesn't move it", () => {
    expect(resolve("2026-11-02T10:00:00Z", "2026-11-03T14:30:00Z").toISOString()).toBe("2026-11-03T14:30:00.000Z");
  });

  it("honours a preferred time exactly at opening", () => {
    expect(resolve("2026-11-02T10:00:00Z", "2026-11-03T08:00:00Z").toISOString()).toBe("2026-11-03T08:00:00.000Z");
  });

  it("honours a preferred time exactly 7 days ahead", () => {
    expect(resolve("2026-11-02T10:00:00Z", "2026-11-09T10:00:00Z").toISOString()).toBe("2026-11-09T10:00:00.000Z");
  });

  it.each([
    ["2026-11-03T07:59:00Z", "before opening"],
    ["2026-11-03T19:45:00Z", "start of the closing buffer"],
    ["2026-11-03T19:59:00Z", "inside the closing buffer"],
    ["2026-11-03T20:30:00Z", "after close"],
    ["2026-11-07T12:50:00Z", "Saturday closing buffer"],
    ["2026-11-07T14:00:00Z", "Saturday afternoon"],
    ["2026-11-08T10:00:00Z", "Sunday"],
  ])("rejects %s (%s) with OUTSIDE_CALLBACK_HOURS rather than moving it", (preferred) => {
    expect(reasonOf(() => resolve("2026-11-02T10:00:00Z", preferred))).toBe(CallbackTimeReason.OUTSIDE_CALLBACK_HOURS);
  });

  it("rejects a bank holiday with OUTSIDE_CALLBACK_HOURS", () => {
    // Asked on Thursday 30 April for Monday 4 May 2026 (Early May bank holiday)
    expect(reasonOf(() => resolve("2026-04-30T10:00:00Z", "2026-05-04T10:00:00Z"))).toBe(
      CallbackTimeReason.OUTSIDE_CALLBACK_HOURS,
    );
  });

  it("rejects more than 7 days ahead with TOO_FAR_AHEAD", () => {
    expect(reasonOf(() => resolve("2026-11-02T10:00:00Z", "2026-11-09T10:00:01Z"))).toBe(
      CallbackTimeReason.TOO_FAR_AHEAD,
    );
  });

  it("reports TOO_FAR_AHEAD ahead of OUTSIDE_CALLBACK_HOURS when both apply", () => {
    // Sunday in two weeks: the customer needs a different day regardless of the hours
    expect(reasonOf(() => resolve("2026-11-02T10:00:00Z", "2026-11-15T10:00:00Z"))).toBe(
      CallbackTimeReason.TOO_FAR_AHEAD,
    );
  });

  it("honours a configurable booking window", () => {
    expect(reasonOf(() => resolve("2026-11-02T10:00:00Z", "2026-11-05T10:00:00Z", { maxDaysAhead: 2 }))).toBe(
      CallbackTimeReason.TOO_FAR_AHEAD,
    );
  });

  it("throws ValidationError so the handler reports INVALID rather than ERROR", () => {
    expect(() => resolve("2026-11-02T10:00:00Z", "2026-11-08T10:00:00Z")).toThrow(ValidationError);
  });

  describe("across the clock changes", () => {
    it("BST start: 08:30 BST on Monday 30 March 2026 is valid, 07:30 BST is not", () => {
      expect(resolve("2026-03-27T10:00:00Z", "2026-03-30T07:30:00Z").toISOString()).toBe("2026-03-30T07:30:00.000Z");
      expect(reasonOf(() => resolve("2026-03-27T10:00:00Z", "2026-03-30T06:30:00Z"))).toBe(
        CallbackTimeReason.OUTSIDE_CALLBACK_HOURS,
      );
    });

    it("BST start: 19:30Z on Monday 30 March 2026 is 20:30 BST, rejected", () => {
      expect(reasonOf(() => resolve("2026-03-27T10:00:00Z", "2026-03-30T19:30:00Z"))).toBe(
        CallbackTimeReason.OUTSIDE_CALLBACK_HOURS,
      );
    });

    it("BST end: 07:30Z on Monday 26 October 2026 is 07:30 GMT, rejected; 08:30Z is valid", () => {
      expect(reasonOf(() => resolve("2026-10-23T10:00:00Z", "2026-10-26T07:30:00Z"))).toBe(
        CallbackTimeReason.OUTSIDE_CALLBACK_HOURS,
      );
      expect(resolve("2026-10-23T10:00:00Z", "2026-10-26T08:30:00Z").toISOString()).toBe("2026-10-26T08:30:00.000Z");
    });

    it("BST end: 19:30Z on Monday 26 October 2026 is 19:30 GMT, valid (would be 20:30 in BST)", () => {
      expect(resolve("2026-10-23T10:00:00Z", "2026-10-26T19:30:00Z").toISOString()).toBe("2026-10-26T19:30:00.000Z");
    });
  });
});

describe("toSchedulerAtExpression", () => {
  it("formats as at(...) in UTC without milliseconds or offset", () => {
    expect(toSchedulerAtExpression(new Date("2026-11-02T14:30:45.123Z"))).toBe("at(2026-11-02T14:30:45)");
  });

  it("expresses a BST local opening time as its UTC instant", () => {
    // Monday 30 March 2026 08:00 BST
    const opening = resolve("2026-03-28T12:45:00Z");
    expect(toSchedulerAtExpression(opening)).toBe("at(2026-03-30T07:00:00)");
  });
});
