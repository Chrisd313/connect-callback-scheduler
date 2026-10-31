import type { ConnectContactFlowEvent } from "aws-lambda";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { handler, setServiceForTesting } from "../src/handlers/createCallback.js";
import type { CallbackService } from "../src/lib/callbackService.js";
import { ValidationError } from "../src/lib/validation.js";

function event(parameters: Record<string, string> = {}): ConnectContactFlowEvent {
  return {
    Name: "ContactFlowEvent",
    Details: {
      ContactData: {
        ContactId: "contact-1",
        CustomerEndpoint: { Address: "+447700900123", Type: "TELEPHONE_NUMBER" },
        Queue: {
          ARN: "arn:aws:connect:eu-west-2:111111111111:instance/instance-1/queue/queue-1",
          Name: "General",
        },
      },
      Parameters: parameters,
    },
  } as unknown as ConnectContactFlowEvent;
}

function fakeService(impl: CallbackService["createCallback"]) {
  const createCallback = vi.fn(impl);
  setServiceForTesting({ createCallback } as unknown as CallbackService);
  return createCallback;
}

describe("createCallback handler", () => {
  afterAll(() => setServiceForTesting(undefined));

  it("defaults the number and queue from the contact and returns SCHEDULED", async () => {
    const createCallback = fakeService(async () => ({
      callbackId: "cb-123",
      scheduledFor: "2026-11-02T10:15:00.000Z",
      scheduledForLocal: "Monday 2 November at 10:15",
      alreadyExisted: false,
    }));

    const result = await handler(event());

    expect(createCallback).toHaveBeenCalledWith({
      sourceContactId: "contact-1",
      phoneNumber: "+447700900123",
      queueId: "queue-1",
      preferredTime: undefined,
    });
    expect(result).toEqual({
      result: "SCHEDULED",
      callbackId: "cb-123",
      scheduledFor: "2026-11-02T10:15:00.000Z",
      scheduledForLocal: "Monday 2 November at 10:15",
    });
  });

  it("prefers parameters from the flow over contact data", async () => {
    const createCallback = fakeService(async () => ({
      callbackId: "cb-123",
      scheduledFor: "2026-11-02T16:00:00.000Z",
      scheduledForLocal: "Monday 2 November at 16:00",
      alreadyExisted: false,
    }));

    await handler(
      event({ callbackNumber: "07700 900999", queueId: "queue-2", preferredTime: "2026-11-02T16:00:00Z" }),
    );

    expect(createCallback).toHaveBeenCalledWith({
      sourceContactId: "contact-1",
      phoneNumber: "07700 900999",
      queueId: "queue-2",
      preferredTime: "2026-11-02T16:00:00Z",
    });
  });

  it("returns INVALID for validation errors", async () => {
    fakeService(async () => {
      throw new ValidationError("Preferred callback time must be in the future");
    });

    expect(await handler(event())).toEqual({
      result: "INVALID",
      reason: "Preferred callback time must be in the future",
    });
  });

  it("returns the machine-readable reason code when a validation error has one", async () => {
    fakeService(async () => {
      throw new ValidationError("Preferred callback time is outside callback hours", "OUTSIDE_CALLBACK_HOURS");
    });

    expect(await handler(event({ preferredTime: "2026-11-01T10:00:00Z" }))).toEqual({
      result: "INVALID",
      reason: "OUTSIDE_CALLBACK_HOURS",
    });
  });

  it("returns ERROR without leaking details for unexpected failures", async () => {
    fakeService(async () => {
      throw new Error("ProvisionedThroughputExceededException");
    });

    expect(await handler(event())).toEqual({ result: "ERROR", reason: "INTERNAL_ERROR" });
  });

  describe("with misconfigured callback hours", () => {
    const REQUIRED_ENV = {
      CALLBACKS_TABLE: "callbacks-test",
      CONNECT_INSTANCE_ID: "instance-1",
      OUTBOUND_CONTACT_FLOW_ID: "flow-1",
      DISPATCH_FUNCTION_ARN: "arn:aws:lambda:eu-west-2:111111111111:function:dispatch",
      SCHEDULER_ROLE_ARN: "arn:aws:iam::111111111111:role/scheduler",
    };
    const touched = [...Object.keys(REQUIRED_ENV), "CALLBACK_HOURS"];

    afterEach(() => {
      for (const key of touched) delete process.env[key];
      setServiceForTesting(undefined);
    });

    it("returns ERROR and logs the config problem instead of throwing out of the flow", async () => {
      Object.assign(process.env, REQUIRED_ENV, { CALLBACK_HOURS: "mon-fri=8am-8pm" });
      setServiceForTesting(undefined); // force getService() to run loadConfig()
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        expect(await handler(event())).toEqual({ result: "ERROR", reason: "INTERNAL_ERROR" });
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(JSON.parse(errorLog.mock.calls[0][0])).toMatchObject({
          message: "Failed to schedule callback",
          error: 'Invalid CALLBACK_HOURS: bad time range "8am-8pm" (expected HH:MM-HH:MM)',
        });
      } finally {
        errorLog.mockRestore();
      }
    });
  });
});
