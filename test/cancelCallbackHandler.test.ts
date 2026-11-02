import type { ConnectContactFlowEvent } from "aws-lambda";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler, setServiceForTesting } from "../src/handlers/cancelCallback.js";
import { CancelCallbacksError, type CancelCallbackService } from "../src/lib/cancelCallbackService.js";
import { ValidationError } from "../src/lib/validation.js";

function event(parameters: Record<string, string> = {}, customerAddress: string | null = "+447700900123") {
  return {
    Name: "ContactFlowEvent",
    Details: {
      ContactData: {
        ContactId: "contact-1",
        CustomerEndpoint: customerAddress ? { Address: customerAddress, Type: "TELEPHONE_NUMBER" } : null,
      },
      Parameters: parameters,
    },
  } as unknown as ConnectContactFlowEvent;
}

function fakeService(impl: CancelCallbackService["cancelForPhoneNumber"]) {
  const cancelForPhoneNumber = vi.fn(impl);
  setServiceForTesting({ cancelForPhoneNumber } as unknown as CancelCallbackService);
  return cancelForPhoneNumber;
}

describe("cancelCallback handler", () => {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];
  const logged = (spy: number) => spies[spy].mock.calls.map((c) => JSON.parse(String(c[0])));

  beforeEach(() => spies.forEach((s) => s.mockClear()));
  afterEach(() => {
    const logged = spies.flatMap((s) => s.mock.calls).map((c) => String(c[0])).join("\n");
    expect(logged, "phone numbers must not appear in logs").not.toMatch(/447700900|7700 ?900/);
  });
  afterAll(() => {
    setServiceForTesting(undefined);
    spies.forEach((s) => s.mockRestore());
  });

  it("uses the caller's number and returns CANCELLED with the count as a string", async () => {
    const cancel = fakeService(async () => ({ cancelledCount: 2, scheduleDeleteFailures: 0 }));

    const result = await handler(event());

    expect(cancel).toHaveBeenCalledWith("+447700900123");
    expect(result).toEqual({ result: "CANCELLED", cancelledCount: "2" });
  });

  it("prefers a callbackNumber parameter from the flow", async () => {
    const cancel = fakeService(async () => ({ cancelledCount: 1, scheduleDeleteFailures: 0 }));

    await handler(event({ callbackNumber: "07700 900999" }));

    expect(cancel).toHaveBeenCalledWith("07700 900999");
  });

  it("returns NONE_FOUND when nothing was scheduled", async () => {
    fakeService(async () => ({ cancelledCount: 0, scheduleDeleteFailures: 0 }));

    expect(await handler(event())).toEqual({ result: "NONE_FOUND", cancelledCount: "0" });
  });

  it("returns INVALID MISSING_DETAILS when there is no number at all", async () => {
    const cancel = fakeService(async () => ({ cancelledCount: 0, scheduleDeleteFailures: 0 }));

    expect(await handler(event({}, null))).toEqual({ result: "INVALID", reason: "MISSING_DETAILS" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("returns INVALID for a number that can't be normalised (e.g. withheld)", async () => {
    fakeService(async () => {
      throw new ValidationError("Not a valid UK phone number: anonymous");
    });

    expect(await handler(event({}, "anonymous"))).toEqual({
      result: "INVALID",
      reason: "Not a valid UK phone number: anonymous",
    });
  });

  it("returns CANCELLED with the count when a schedule delete failed, and logs how many", async () => {
    fakeService(async () => ({ cancelledCount: 2, scheduleDeleteFailures: 1 }));

    expect(await handler(event())).toEqual({ result: "CANCELLED", cancelledCount: "2" });
    expect(logged(0)).toContainEqual(
      expect.objectContaining({ message: "Cancel request handled", cancelledCount: 2, scheduleDeleteFailures: 1 }),
    );
  });

  it("returns ERROR with the count when some status updates failed (mixed outcome)", async () => {
    fakeService(async () => {
      throw new CancelCallbacksError([new Error("ProvisionedThroughputExceededException")], "Failed to cancel 1 of 3 callbacks (2 cancelled)", 2);
    });

    expect(await handler(event())).toEqual({ result: "ERROR", reason: "INTERNAL_ERROR", cancelledCount: "2" });
    expect(logged(2)).toContainEqual(expect.objectContaining({ message: "Failed to cancel callbacks", cancelledCount: 2 }));
  });

  it("returns ERROR without a count when the failure happened before any update (e.g. the lookup)", async () => {
    fakeService(async () => {
      throw new Error("ProvisionedThroughputExceededException");
    });

    expect(await handler(event())).toEqual({ result: "ERROR", reason: "INTERNAL_ERROR" });
  });

  it("never throws, even if the service throws something that isn't an Error", async () => {
    fakeService(async () => {
      throw "boom";
    });

    expect(await handler(event())).toEqual({ result: "ERROR", reason: "INTERNAL_ERROR" });
  });

  it("returns only string values, as Connect requires", async () => {
    fakeService(async () => ({ cancelledCount: 3, scheduleDeleteFailures: 0 }));
    for (const value of Object.values(await handler(event()))) {
      expect(typeof value).toBe("string");
    }

    fakeService(async () => {
      throw new CancelCallbacksError([], "Failed to cancel 1 of 2 callbacks (1 cancelled)", 1);
    });
    for (const value of Object.values(await handler(event()))) {
      expect(typeof value).toBe("string");
    }
  });
});
