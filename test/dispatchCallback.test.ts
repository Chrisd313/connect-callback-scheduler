import {
  ConnectClient,
  InvalidParameterException,
  StartOutboundVoiceContactCommand,
  ThrottlingException,
} from "@aws-sdk/client-connect";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINAL_FAILURE_MESSAGE, handler, setDepsForTesting } from "../src/handlers/dispatchCallback.js";
import { CancelCallbackService } from "../src/lib/cancelCallbackService.js";
import type { AppConfig } from "../src/lib/config.js";
import { DEFAULT_CALLBACK_HOURS } from "../src/lib/defaultCallbackHours.js";
import { CallbackRepository } from "../src/lib/repository.js";
import { CallbackScheduler } from "../src/lib/scheduler.js";
import type { CallbackRecord } from "../src/lib/types.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const connectMock = mockClient(ConnectClient);
const schedulerMock = mockClient(SchedulerClient);

const PHONE = "+447700900123";
const NOW = new Date("2026-11-02T10:15:00.000Z");

const config: AppConfig = {
  tableName: "callbacks-test",
  connectInstanceId: "instance-1",
  outboundContactFlowId: "flow-1",
  dispatchFunctionArn: "n/a",
  schedulerRoleArn: "n/a",
  scheduleGroupName: "connect-callbacks-test",
  defaultCallbackDelayMinutes: 15,
  maxBookingDaysAhead: 7,
  callbackHours: DEFAULT_CALLBACK_HOURS,
  recordRetentionDays: 30,
  dispatchMaxAttempts: 3,
  dispatchRetryDelaySeconds: 60,
};

function record(status: CallbackRecord["status"] = "SCHEDULED", updatedAt = "2026-11-02T10:00:00.000Z"): CallbackRecord {
  return {
    callbackId: "cb-123",
    sourceContactId: "contact-1",
    phoneNumber: PHONE,
    queueId: "queue-1",
    scheduledFor: "2026-11-02T10:15:00.000Z",
    status,
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt,
    expiresAt: 1_800_000_000,
  };
}

const conditionalCheckFailed = () =>
  new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
const throttling = () =>
  new ThrottlingException({ message: "Rate exceeded", $metadata: { httpStatusCode: 429 } });
const invalidParameter = () =>
  new InvalidParameterException({ message: "Invalid destination phone number", $metadata: { httpStatusCode: 400 } });

/** Retry schedules created, in order, as { name, at }. */
function retrySchedules() {
  return schedulerMock.commandCalls(CreateScheduleCommand).map((c) => ({
    name: c.args[0].input.Name!,
    at: c.args[0].input.ScheduleExpression!,
  }));
}

/** Status transitions attempted, in order. */
function transitions(): Array<{ from: string; to: string }> {
  return ddbMock.commandCalls(UpdateCommand).map((c) => ({
    from: c.args[0].input.ExpressionAttributeValues![":from"] as string,
    to: c.args[0].input.ExpressionAttributeValues![":to"] as string,
  }));
}

function outboundCalls() {
  return connectMock.commandCalls(StartOutboundVoiceContactCommand);
}

/**
 * In-memory table with DynamoDB's conditional-update semantics, so the dispatch handler
 * and the cancel service can race against shared state. Only what the repository uses.
 */
function fakeTable(...initial: CallbackRecord[]) {
  const items = new Map(initial.map((r) => [r.callbackId, { ...r }]));

  ddbMock.on(GetCommand).callsFake(async (input) => ({ Item: items.get(input.Key.callbackId) }));

  ddbMock.on(QueryCommand).callsFake(async (input) => ({
    Items: [...items.values()].filter(
      (i) => i.phoneNumber === input.ExpressionAttributeValues[":p"] && i.status === input.ExpressionAttributeValues[":scheduled"],
    ),
  }));

  ddbMock.on(UpdateCommand).callsFake(async (input) => {
    const item = items.get(input.Key.callbackId);
    const values = input.ExpressionAttributeValues as Record<string, unknown>;
    if (!item || item.status !== values[":from"]) throw conditionalCheckFailed();
    const updated = { ...item, status: values[":to"] as CallbackRecord["status"], updatedAt: values[":updatedAt"] as string };
    for (const [key, value] of Object.entries(values)) {
      if (![":from", ":to", ":updatedAt"].includes(key)) (updated as Record<string, unknown>)[key.slice(1)] = value;
    }
    items.set(item.callbackId, updated);
    return {};
  });

  return items;
}

function makeScheduler(): CallbackScheduler {
  return new CallbackScheduler(
    { dispatchFunctionArn: "arn:dispatch", schedulerRoleArn: "arn:role", scheduleGroupName: config.scheduleGroupName },
    new SchedulerClient({}),
  );
}

function makeCancelService(): CancelCallbackService {
  return new CancelCallbackService({
    repository: new CallbackRepository(config.tableName, DynamoDBDocumentClient.from(new DynamoDBClient({}))),
    scheduler: makeScheduler(),
  });
}

describe("dispatchCallback handler", () => {
  const logSpies = {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
  const logLines = (spy: keyof typeof logSpies) => logSpies[spy].mock.calls.map((c) => JSON.parse(String(c[0])));

  beforeEach(() => {
    ddbMock.reset();
    connectMock.reset();
    schedulerMock.reset();
    schedulerMock.on(DeleteScheduleCommand).resolves({});
    schedulerMock.on(CreateScheduleCommand).resolves({});
    for (const spy of Object.values(logSpies)) spy.mockReset().mockImplementation(() => {});
    setDepsForTesting({
      config,
      repository: new CallbackRepository(config.tableName, DynamoDBDocumentClient.from(new DynamoDBClient({}))),
      connect: new ConnectClient({}),
      scheduler: makeScheduler(),
      clock: () => NOW,
    });
  });

  afterEach(() => {
    const everything = Object.values(logSpies)
      .flatMap((spy) => spy.mock.calls)
      .map((call) => String(call[0]))
      .join("\n");
    expect(everything, "phone numbers must not appear in logs").not.toMatch(/447700900123|7700 ?900123/);
  });

  afterAll(() => {
    setDepsForTesting(undefined);
    for (const spy of Object.values(logSpies)) spy.mockRestore();
  });

  describe("happy path", () => {
    it("claims the callback, starts an outbound call into the original queue and marks it DISPATCHED", async () => {
      const table = fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "outbound-1" });

      await handler({ callbackId: "cb-123" });

      expect(outboundCalls()[0].args[0].input).toMatchObject({
        InstanceId: "instance-1",
        ContactFlowId: "flow-1",
        QueueId: "queue-1",
        DestinationPhoneNumber: PHONE,
        Attributes: { callbackId: "cb-123", sourceContactId: "contact-1" },
        ClientToken: "cb-123",
      });
      expect(transitions()).toEqual([
        { from: "SCHEDULED", to: "DISPATCHING" },
        { from: "DISPATCHING", to: "DISPATCHED" },
      ]);
      expect(table.get("cb-123")).toMatchObject({ status: "DISPATCHED", outboundContactId: "outbound-1", attempts: 1 });
      expect(logLines("log")).toContainEqual(
        expect.objectContaining({ message: "Callback dispatched", outboundContactId: "outbound-1", attempt: 1, phone: "*********0123" }),
      );
      expect(retrySchedules()).toEqual([]);
    });

    it("claims the record before calling Connect, and the claim is conditional on SCHEDULED", async () => {
      fakeTable(record());
      const order: string[] = [];
      ddbMock.on(UpdateCommand).callsFake(async (input) => {
        order.push(`update:${input.ExpressionAttributeValues[":from"]}->${input.ExpressionAttributeValues[":to"]}`);
        return {};
      });
      connectMock.on(StartOutboundVoiceContactCommand).callsFake(async () => {
        order.push("connect");
        return { ContactId: "outbound-1" };
      });

      await handler({ callbackId: "cb-123" });

      expect(order).toEqual(["update:SCHEDULED->DISPATCHING", "connect", "update:DISPATCHING->DISPATCHED"]);
      expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toBe("#status = :from");
    });

    it("logs the claim with the callbackId after claiming and before calling Connect, so a timeout mid-call can be traced", async () => {
      fakeTable(record());
      const order: string[] = [];
      ddbMock.on(UpdateCommand).callsFake(async (input) => {
        order.push(`update:${input.ExpressionAttributeValues[":to"]}`);
        return {};
      });
      logSpies.log.mockImplementation((line: string) => {
        const parsed = JSON.parse(line);
        if (parsed.message === "Callback claimed, calling Connect") order.push(`log:${parsed.callbackId}`);
      });
      connectMock.on(StartOutboundVoiceContactCommand).callsFake(async () => {
        order.push("connect");
        return { ContactId: "outbound-1" };
      });

      await handler({ callbackId: "cb-123" });

      expect(order).toEqual(["update:DISPATCHING", "log:cb-123", "connect", "update:DISPATCHED"]);
    });

    it("does not log the claim when the claim fails or the record is not SCHEDULED", async () => {
      fakeTable(record("CANCELLED"));

      await handler({ callbackId: "cb-123" });

      expect(logLines("log")).not.toContainEqual(expect.objectContaining({ message: "Callback claimed, calling Connect" }));
    });
  });

  describe("nothing to do", () => {
    it.each(["DISPATCHED", "CANCELLED", "FAILED"] as const)("does nothing when the callback is %s", async (status) => {
      fakeTable(record(status));

      await handler({ callbackId: "cb-123" });

      expect(outboundCalls()).toHaveLength(0);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(logLines("log")).toContainEqual(expect.objectContaining({ callbackId: "cb-123", status }));
    });

    it("does nothing for an unknown callback", async () => {
      fakeTable();

      await handler({ callbackId: "missing" });

      expect(outboundCalls()).toHaveLength(0);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(logLines("warn")).toContainEqual(expect.objectContaining({ callbackId: "missing" }));
    });

    it("does not call again when an earlier dispatch claimed the record and never finished, and warns with the claim's age", async () => {
      fakeTable(record("DISPATCHING", "2026-11-02T10:14:15.000Z"));

      await handler({ callbackId: "cb-123" });

      expect(outboundCalls()).toHaveLength(0);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(logLines("warn")).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("claimed by an earlier dispatch"), // README's Logs Insights filter
          callbackId: "cb-123",
          claimedAt: "2026-11-02T10:14:15.000Z",
          claimAgeSeconds: 45,
        }),
      ]);
    });
  });

  describe("claim failures", () => {
    it("does not call Connect when the claim throws; logs an error with the callbackId and rethrows", async () => {
      const table = fakeTable(record());
      ddbMock
        .on(UpdateCommand, { ExpressionAttributeValues: { ":to": "DISPATCHING" } } as never)
        .rejects(new Error("ProvisionedThroughputExceededException"));
      connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "outbound-1" });

      await expect(handler({ callbackId: "cb-123" })).rejects.toThrow("ProvisionedThroughputExceededException");

      expect(outboundCalls()).toHaveLength(0);
      expect(transitions()).toEqual([{ from: "SCHEDULED", to: "DISPATCHING" }]);
      expect(table.get("cb-123")).toMatchObject({ status: "SCHEDULED" });
      expect(logLines("error")).toEqual([
        expect.objectContaining({
          message: "Could not claim callback for dispatch; not calling",
          callbackId: "cb-123",
          error: "ProvisionedThroughputExceededException",
        }),
      ]);
    });

    it("if a thrown claim had in fact applied, the retry takes the DISPATCHING path and does not call", async () => {
      const table = fakeTable(record());
      // First claim: the write lands, then the response is lost.
      ddbMock.on(UpdateCommand, { ExpressionAttributeValues: { ":to": "DISPATCHING" } } as never).callsFake(async () => {
        table.set("cb-123", { ...table.get("cb-123")!, status: "DISPATCHING", updatedAt: NOW.toISOString() });
        throw new Error("TimeoutError");
      });
      connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "outbound-1" });
      await expect(handler({ callbackId: "cb-123" })).rejects.toThrow("TimeoutError");

      await handler({ callbackId: "cb-123" });

      expect(outboundCalls()).toHaveLength(0);
      expect(table.get("cb-123")).toMatchObject({ status: "DISPATCHING" });
      expect(logLines("warn")).toContainEqual(expect.objectContaining({ callbackId: "cb-123", claimAgeSeconds: 0 }));
    });
  });

  describe("racing a cancel", () => {
    it("cancel arriving while the Connect call is in flight cancels nothing; the dispatch completes", async () => {
      const table = fakeTable(record());
      const cancel = makeCancelService();
      let cancelResult: { cancelledCount: number; scheduleDeleteFailures: number } | undefined;
      connectMock.on(StartOutboundVoiceContactCommand).callsFake(async () => {
        cancelResult = await cancel.cancelForPhoneNumber(PHONE);
        return { ContactId: "outbound-1" };
      });

      await handler({ callbackId: "cb-123" });

      expect(cancelResult).toEqual({ cancelledCount: 0, scheduleDeleteFailures: 0 });
      expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(0);
      expect(table.get("cb-123")).toMatchObject({ status: "DISPATCHED", outboundContactId: "outbound-1" });
    });

    it("cancel that commits between the dispatch read and its claim wins; no call is placed", async () => {
      const table = fakeTable(record());
      const cancel = makeCancelService();
      let cancelResult: { cancelledCount: number; scheduleDeleteFailures: number } | undefined;
      ddbMock.on(GetCommand).callsFake(async (input) => {
        const stale = { ...table.get(input.Key.callbackId) }; // what dispatch sees: still SCHEDULED
        cancelResult = await cancel.cancelForPhoneNumber(PHONE);
        return { Item: stale };
      });
      connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "outbound-1" });

      await handler({ callbackId: "cb-123" });

      expect(cancelResult).toEqual({ cancelledCount: 1, scheduleDeleteFailures: 0 });
      expect(outboundCalls()).toHaveLength(0);
      expect(table.get("cb-123")).toMatchObject({ status: "CANCELLED" });
      expect(table.get("cb-123")!.outboundContactId).toBeUndefined();
      expect(logLines("log")).toContainEqual(
        expect.objectContaining({ message: "Callback no longer SCHEDULED, not dispatching", callbackId: "cb-123" }),
      );
    });

    it("cancel that commits before the dispatch reads the record wins; no call is placed", async () => {
      const table = fakeTable(record());
      const cancel = makeCancelService();
      connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "outbound-1" });

      expect(await cancel.cancelForPhoneNumber(PHONE)).toEqual({ cancelledCount: 1, scheduleDeleteFailures: 0 });
      await handler({ callbackId: "cb-123" });

      expect(outboundCalls()).toHaveLength(0);
      expect(table.get("cb-123")).toMatchObject({ status: "CANCELLED" });
    });
  });

  describe("duplicate invocations", () => {
    it("two concurrent invocations for the same callback place exactly one call", async () => {
      const table = fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "outbound-1" });

      await Promise.all([handler({ callbackId: "cb-123" }), handler({ callbackId: "cb-123" })]);

      expect(outboundCalls()).toHaveLength(1);
      expect(table.get("cb-123")).toMatchObject({ status: "DISPATCHED", outboundContactId: "outbound-1" });
    });

    it("a retry after a successful dispatch places no second call", async () => {
      fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "outbound-1" });

      await handler({ callbackId: "cb-123" });
      await handler({ callbackId: "cb-123" });

      expect(outboundCalls()).toHaveLength(1);
    });
  });

  describe("Connect errors: retries", () => {
    it("transient failure then success: schedules one retry, then the retry dispatches", async () => {
      const table = fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).rejectsOnce(throttling()).resolves({ ContactId: "outbound-1" });

      await handler({ callbackId: "cb-123" }); // attempt 1: throttled

      expect(retrySchedules()).toEqual([{ name: "callback-cb-123-retry-1", at: "at(2026-11-02T10:16:00)" }]);
      const created = schedulerMock.commandCalls(CreateScheduleCommand)[0].args[0].input;
      expect(created).toMatchObject({
        GroupName: "connect-callbacks-test",
        ActionAfterCompletion: "DELETE",
        Target: { Arn: "arn:dispatch", RoleArn: "arn:role" },
      });
      expect(JSON.parse(created.Target!.Input!)).toEqual({ callbackId: "cb-123" });
      expect(table.get("cb-123")).toMatchObject({ status: "SCHEDULED", attempts: 1, failureReason: "Rate exceeded" });
      expect(table.get("cb-123")!.outboundContactId).toBeUndefined();
      expect(logLines("warn")).toEqual([
        expect.objectContaining({
          message: "Callback dispatch failed, retry scheduled",
          callbackId: "cb-123",
          attempt: 1,
          maxAttempts: 3,
          retryAt: "2026-11-02T10:16:00.000Z",
          error: "Rate exceeded",
        }),
      ]);
      expect(logLines("error")).toEqual([]);

      await handler({ callbackId: "cb-123" }); // attempt 2, fired by the retry schedule

      expect(outboundCalls()).toHaveLength(2);
      expect(outboundCalls().map((c) => c.args[0].input.ClientToken)).toEqual(["cb-123", "cb-123"]);
      expect(table.get("cb-123")).toMatchObject({ status: "DISPATCHED", outboundContactId: "outbound-1", attempts: 2 });
      expect(retrySchedules()).toHaveLength(1);
      expect(transitions()).toEqual([
        { from: "SCHEDULED", to: "DISPATCHING" },
        { from: "DISPATCHING", to: "SCHEDULED" },
        { from: "SCHEDULED", to: "DISPATCHING" },
        { from: "DISPATCHING", to: "DISPATCHED" },
      ]);
    });

    it("creates the retry schedule before releasing the claim", async () => {
      fakeTable(record());
      const order: string[] = [];
      connectMock.on(StartOutboundVoiceContactCommand).rejects(throttling());
      schedulerMock.on(CreateScheduleCommand).callsFake(async () => {
        order.push("create-schedule");
        return {};
      });
      ddbMock.on(UpdateCommand, { ExpressionAttributeValues: { ":to": "SCHEDULED" } } as never).callsFake(async () => {
        order.push("release");
        return {};
      });

      await handler({ callbackId: "cb-123" });

      expect(order).toEqual(["create-schedule", "release"]);
    });

    it("retries exhausted: the record ends FAILED with the final reason and attempt count, and the final failure is logged", async () => {
      const table = fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).rejects(throttling());

      await handler({ callbackId: "cb-123" });
      await handler({ callbackId: "cb-123" });
      await handler({ callbackId: "cb-123" });

      expect(outboundCalls()).toHaveLength(3);
      expect(retrySchedules().map((r) => r.name)).toEqual(["callback-cb-123-retry-1", "callback-cb-123-retry-2"]);
      expect(table.get("cb-123")).toMatchObject({ status: "FAILED", attempts: 3, failureReason: "Rate exceeded" });
      expect(logLines("error")).toEqual([
        expect.objectContaining({
          message: FINAL_FAILURE_MESSAGE,
          callbackId: "cb-123",
          attempt: 3,
          maxAttempts: 3,
          retryable: true,
          error: "Rate exceeded",
        }),
      ]);

      await handler({ callbackId: "cb-123" }); // a later duplicate finds FAILED
      expect(outboundCalls()).toHaveLength(3);
    });

    it("permanent failure: goes straight to FAILED with the reason, no retry, no throw", async () => {
      const table = fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).rejects(invalidParameter());

      await handler({ callbackId: "cb-123" });

      expect(outboundCalls()).toHaveLength(1);
      expect(retrySchedules()).toEqual([]);
      expect(transitions()).toEqual([
        { from: "SCHEDULED", to: "DISPATCHING" },
        { from: "DISPATCHING", to: "FAILED" },
      ]);
      expect(table.get("cb-123")).toMatchObject({
        status: "FAILED",
        attempts: 1,
        failureReason: "Invalid destination phone number",
      });
      expect(logLines("error")).toEqual([
        expect.objectContaining({ message: FINAL_FAILURE_MESSAGE, callbackId: "cb-123", attempt: 1, retryable: false }),
      ]);
      expect(logLines("warn")).toEqual([]);
    });

    it("cancel between attempts: cancels the waiting retry and deletes its schedule; the retry then does not call", async () => {
      const table = fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).rejectsOnce(throttling()).resolves({ ContactId: "outbound-1" });
      await handler({ callbackId: "cb-123" }); // attempt 1: throttled, retry-1 scheduled

      const cancelled = await makeCancelService().cancelForPhoneNumber(PHONE);
      await handler({ callbackId: "cb-123" }); // retry-1 fires

      expect(cancelled).toEqual({ cancelledCount: 1, scheduleDeleteFailures: 0 });
      expect(schedulerMock.commandCalls(DeleteScheduleCommand).map((c) => c.args[0].input.Name)).toEqual([
        "callback-cb-123-retry-1",
      ]);
      expect(outboundCalls()).toHaveLength(1);
      expect(table.get("cb-123")).toMatchObject({ status: "CANCELLED", attempts: 1 });
    });

    it("duplicate invocation after a retried success places no second call", async () => {
      fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).rejectsOnce(throttling()).resolves({ ContactId: "outbound-1" });
      await handler({ callbackId: "cb-123" });
      await handler({ callbackId: "cb-123" });

      await handler({ callbackId: "cb-123" }); // e.g. the original schedule delivered twice

      expect(outboundCalls()).toHaveLength(2);
      expect(logLines("log")).toContainEqual(expect.objectContaining({ message: "Skipping dispatch, callback not in SCHEDULED state", status: "DISPATCHED" }));
    });

    it("honours a configured attempt limit of 1 (no retries at all)", async () => {
      const table = fakeTable(record());
      setDepsForTesting({
        config: { ...config, dispatchMaxAttempts: 1 },
        repository: new CallbackRepository(config.tableName, DynamoDBDocumentClient.from(new DynamoDBClient({}))),
        connect: new ConnectClient({}),
        scheduler: makeScheduler(),
        clock: () => NOW,
      });
      connectMock.on(StartOutboundVoiceContactCommand).rejects(throttling());

      await handler({ callbackId: "cb-123" });

      expect(retrySchedules()).toEqual([]);
      expect(table.get("cb-123")).toMatchObject({ status: "FAILED", attempts: 1 });
    });

    it("a record from before retries existed (no attempts field) counts as attempt 1", async () => {
      const table = fakeTable(record());
      delete table.get("cb-123")!.attempts;
      connectMock.on(StartOutboundVoiceContactCommand).rejects(throttling());

      await handler({ callbackId: "cb-123" });

      expect(table.get("cb-123")).toMatchObject({ status: "SCHEDULED", attempts: 1 });
      expect(retrySchedules().map((r) => r.name)).toEqual(["callback-cb-123-retry-1"]);
    });
  });

  describe("Connect errors: when resolving the failure itself fails", () => {
    it("retry schedule cannot be created: the record goes FAILED with both reasons and the final failure is logged", async () => {
      const table = fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).rejects(throttling());
      schedulerMock.on(CreateScheduleCommand).rejects(new Error("SchedulerThrottling"));

      await handler({ callbackId: "cb-123" });

      expect(table.get("cb-123")).toMatchObject({
        status: "FAILED",
        attempts: 1,
        failureReason: "Rate exceeded (retry could not be scheduled: SchedulerThrottling)",
      });
      expect(logLines("error")).toEqual([
        expect.objectContaining({ message: "Could not schedule retry", callbackId: "cb-123", scheduleError: "SchedulerThrottling" }),
        expect.objectContaining({ message: FINAL_FAILURE_MESSAGE, callbackId: "cb-123", retryable: true }),
      ]);
    });

    it("retry scheduled but the claim cannot be released: logs, leaves DISPATCHING and rethrows", async () => {
      const table = fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).rejects(throttling());
      ddbMock
        .on(UpdateCommand, { ExpressionAttributeValues: { ":to": "SCHEDULED" } } as never)
        .rejects(new Error("ProvisionedThroughputExceededException"));

      await expect(handler({ callbackId: "cb-123" })).rejects.toThrow("ProvisionedThroughputExceededException");

      expect(retrySchedules()).toHaveLength(1);
      expect(table.get("cb-123")).toMatchObject({ status: "DISPATCHING" });
      expect(logLines("error")).toEqual([
        expect.objectContaining({
          message: "Retry scheduled but could not release claim; record left DISPATCHING",
          callbackId: "cb-123",
          releaseError: "ProvisionedThroughputExceededException",
        }),
      ]);

      await handler({ callbackId: "cb-123" }); // the retry schedule fires into the stale claim
      expect(outboundCalls()).toHaveLength(1);
      expect(logLines("warn")).toContainEqual(expect.objectContaining({ message: expect.stringContaining("claimed by an earlier dispatch") }));
    });

    it("warns with the callbackId if the FAILED write finds the record no longer DISPATCHING; does not throw", async () => {
      fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).rejects(invalidParameter());
      ddbMock
        .on(UpdateCommand, { ExpressionAttributeValues: { ":to": "FAILED" } } as never)
        .rejects(conditionalCheckFailed());

      await handler({ callbackId: "cb-123" });

      expect(logLines("warn")).toEqual([
        expect.objectContaining({
          message: "Connect call failed but callback was no longer DISPATCHING; status not updated",
          callbackId: "cb-123",
        }),
      ]);
    });

    it("rethrows when the write to FAILED itself throws, after logging the final failure and the write error", async () => {
      fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).rejects(invalidParameter());
      ddbMock
        .on(UpdateCommand, { ExpressionAttributeValues: { ":to": "FAILED" } } as never)
        .rejects(new Error("ProvisionedThroughputExceededException"));

      await expect(handler({ callbackId: "cb-123" })).rejects.toThrow("ProvisionedThroughputExceededException");

      expect(logLines("error")).toEqual([
        expect.objectContaining({ message: FINAL_FAILURE_MESSAGE, callbackId: "cb-123", error: "Invalid destination phone number" }),
        expect.objectContaining({
          message: "Could not mark callback FAILED; record left DISPATCHING",
          callbackId: "cb-123",
          error: "ProvisionedThroughputExceededException",
        }),
      ]);
    });
  });

  describe("persistence errors after the call is placed", () => {
    it("never marks the record FAILED once the call is placed; logs the outbound contact and rethrows", async () => {
      const table = fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "outbound-1" });
      ddbMock
        .on(UpdateCommand, { ExpressionAttributeValues: { ":to": "DISPATCHED" } } as never)
        .rejects(new Error("ProvisionedThroughputExceededException"));

      await expect(handler({ callbackId: "cb-123" })).rejects.toThrow("ProvisionedThroughputExceededException");

      expect(outboundCalls()).toHaveLength(1);
      expect(transitions().map((t) => t.to)).not.toContain("FAILED");
      expect(table.get("cb-123")).toMatchObject({ status: "DISPATCHING" });
      expect(logLines("error")).toEqual([
        expect.objectContaining({
          message: "Call placed but could not mark callback DISPATCHED; record left DISPATCHING",
          callbackId: "cb-123",
          outboundContactId: "outbound-1",
          error: "ProvisionedThroughputExceededException",
        }),
      ]);
    });

    it("warns with the callbackId and outboundContactId if the DISPATCHED write finds the record no longer DISPATCHING; does not throw", async () => {
      fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "outbound-1" });
      ddbMock
        .on(UpdateCommand, { ExpressionAttributeValues: { ":to": "DISPATCHED" } } as never)
        .rejects(conditionalCheckFailed());

      await handler({ callbackId: "cb-123" });

      expect(outboundCalls()).toHaveLength(1);
      expect(logLines("warn")).toEqual([
        expect.objectContaining({
          message: "Call placed but callback was no longer DISPATCHING; status not updated",
          callbackId: "cb-123",
          outboundContactId: "outbound-1",
        }),
      ]);
      expect(logLines("error")).toEqual([]);
    });

    it("a retry after that does not call again", async () => {
      fakeTable(record());
      connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "outbound-1" });
      ddbMock
        .on(UpdateCommand, { ExpressionAttributeValues: { ":to": "DISPATCHED" } } as never)
        .rejects(new Error("ProvisionedThroughputExceededException"));
      await expect(handler({ callbackId: "cb-123" })).rejects.toThrow();

      await handler({ callbackId: "cb-123" });

      expect(outboundCalls()).toHaveLength(1);
      expect(logLines("warn")).toContainEqual(expect.objectContaining({ callbackId: "cb-123", claimAgeSeconds: expect.any(Number) }));
    });
  });
});
