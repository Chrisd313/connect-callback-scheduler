import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteScheduleCommand, ResourceNotFoundException, SchedulerClient } from "@aws-sdk/client-scheduler";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancelCallbackService } from "../src/lib/cancelCallbackService.js";
import { CallbackRepository } from "../src/lib/repository.js";
import { CallbackScheduler } from "../src/lib/scheduler.js";
import type { CallbackRecord } from "../src/lib/types.js";
import { ValidationError } from "../src/lib/validation.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const schedulerMock = mockClient(SchedulerClient);

const PHONE = "+447700900123";

function record(callbackId: string, status: CallbackRecord["status"] = "SCHEDULED"): CallbackRecord {
  return {
    callbackId,
    sourceContactId: `contact-${callbackId}`,
    phoneNumber: PHONE,
    queueId: "queue-1",
    scheduledFor: "2026-11-02T10:15:00.000Z",
    status,
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: 1_800_000_000,
  };
}

function makeService(): CancelCallbackService {
  return new CancelCallbackService({
    repository: new CallbackRepository("callbacks-test", DynamoDBDocumentClient.from(new DynamoDBClient({}))),
    scheduler: new CallbackScheduler(
      {
        dispatchFunctionArn: "n/a",
        schedulerRoleArn: "n/a",
        scheduleGroupName: "connect-callbacks-test",
      },
      new SchedulerClient({}),
    ),
  });
}

const conditionalCheckFailed = () =>
  new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
const scheduleNotFound = () => new ResourceNotFoundException({ message: "Schedule not found", Message: "Schedule not found", $metadata: {} });

/** Which callbackIds were transitioned, in order, with their target status. */
function transitions(): Array<{ callbackId: string; to: string; from: string }> {
  return ddbMock.commandCalls(UpdateCommand).map((c) => ({
    callbackId: c.args[0].input.Key!.callbackId as string,
    from: c.args[0].input.ExpressionAttributeValues![":from"] as string,
    to: c.args[0].input.ExpressionAttributeValues![":to"] as string,
  }));
}

function deletedSchedules(): string[] {
  return schedulerMock.commandCalls(DeleteScheduleCommand).map((c) => c.args[0].input.Name!);
}

describe("CancelCallbackService.cancelForPhoneNumber", () => {
  const logSpies = {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };

  beforeEach(() => {
    ddbMock.reset();
    schedulerMock.reset();
    ddbMock.on(UpdateCommand).resolves({});
    schedulerMock.on(DeleteScheduleCommand).resolves({});
    for (const spy of Object.values(logSpies)) spy.mockClear();
  });

  afterEach(() => {
    // No phone numbers in logs, in any form.
    const everything = Object.values(logSpies)
      .flatMap((spy) => spy.mock.calls)
      .map((call) => String(call[0]))
      .join("\n");
    expect(everything).not.toMatch(/447700900123|7700 ?900123/);
  });

  it("cancels a single scheduled callback and deletes its schedule", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [record("cb-1")] });

    const result = await makeService().cancelForPhoneNumber(PHONE);

    expect(result).toEqual({ cancelledCount: 1 });
    expect(transitions()).toEqual([{ callbackId: "cb-1", from: "SCHEDULED", to: "CANCELLED" }]);
    expect(deletedSchedules()).toEqual(["callback-cb-1"]);
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)[0].args[0].input.GroupName).toBe(
      "connect-callbacks-test",
    );
  });

  it("marks the record CANCELLED before deleting the schedule", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [record("cb-1")] });
    const order: string[] = [];
    ddbMock.on(UpdateCommand).callsFake(async () => {
      order.push("update");
      return {};
    });
    schedulerMock.on(DeleteScheduleCommand).callsFake(async () => {
      order.push("delete");
      return {};
    });

    await makeService().cancelForPhoneNumber(PHONE);

    expect(order).toEqual(["update", "delete"]);
  });

  it("cancels several scheduled callbacks", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [record("cb-1"), record("cb-2"), record("cb-3")] });

    const result = await makeService().cancelForPhoneNumber(PHONE);

    expect(result).toEqual({ cancelledCount: 3 });
    expect(transitions().map((t) => t.callbackId)).toEqual(["cb-1", "cb-2", "cb-3"]);
    expect(deletedSchedules()).toEqual(["callback-cb-1", "callback-cb-2", "callback-cb-3"]);
  });

  it("returns zero and touches nothing when there are no scheduled callbacks", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await makeService().cancelForPhoneNumber(PHONE);

    expect(result).toEqual({ cancelledCount: 0 });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)).toHaveLength(0);
  });

  it("queries the phone/status index for SCHEDULED rows only", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await makeService().cancelForPhoneNumber(PHONE);

    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query).toMatchObject({
      TableName: "callbacks-test",
      IndexName: "byPhoneNumberStatus",
      KeyConditionExpression: "phoneNumber = :p AND #status = :scheduled",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":p": PHONE, ":scheduled": "SCHEDULED" },
    });
    expect(query.FilterExpression).toBeUndefined();
  });

  it("follows pagination when the index query returns more than one page", async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [record("cb-1")], LastEvaluatedKey: { callbackId: "cb-1" } })
      .resolvesOnce({ Items: [record("cb-2")] });

    const result = await makeService().cancelForPhoneNumber(PHONE);

    expect(result).toEqual({ cancelledCount: 2 });
    expect(ddbMock.commandCalls(QueryCommand)[1].args[0].input.ExclusiveStartKey).toEqual({ callbackId: "cb-1" });
  });

  describe("number formats", () => {
    it.each(["07700 900123", "+447700900123", "447700900123", "00447700900123", "(07700) 900-123"])(
      "normalises %s before looking it up",
      async (input) => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        await makeService().cancelForPhoneNumber(input);

        expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toMatchObject({
          ":p": PHONE,
        });
      },
    );

    it("rejects a number that can't be normalised without querying", async () => {
      await expect(makeService().cancelForPhoneNumber("anonymous")).rejects.toThrow(ValidationError);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });
  });

  describe("callbacks that must not be touched", () => {
    it("ignores DISPATCHED, FAILED and CANCELLED records even if the index returns them", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [record("cb-done", "DISPATCHED"), record("cb-live"), record("cb-failed", "FAILED"), record("cb-gone", "CANCELLED")],
      });

      const result = await makeService().cancelForPhoneNumber(PHONE);

      expect(result).toEqual({ cancelledCount: 1 });
      expect(transitions()).toEqual([{ callbackId: "cb-live", from: "SCHEDULED", to: "CANCELLED" }]);
      expect(deletedSchedules()).toEqual(["callback-cb-live"]);
    });

    it("does not count or delete the schedule for a callback dispatched between the query and the update", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [record("cb-racing"), record("cb-live")] });
      ddbMock
        .on(UpdateCommand, { Key: { callbackId: "cb-racing" } })
        .rejects(conditionalCheckFailed());

      const result = await makeService().cancelForPhoneNumber(PHONE);

      expect(result).toEqual({ cancelledCount: 1 });
      expect(deletedSchedules()).toEqual(["callback-cb-live"]);
    });

    it("the update is conditional on the record still being SCHEDULED", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [record("cb-1")] });

      await makeService().cancelForPhoneNumber(PHONE);

      expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toBe("#status = :from");
    });
  });

  describe("schedule already gone", () => {
    it("still counts the cancellation when the schedule has already fired or been deleted", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [record("cb-1")] });
      schedulerMock.on(DeleteScheduleCommand).rejects(scheduleNotFound());

      const result = await makeService().cancelForPhoneNumber(PHONE);

      expect(result).toEqual({ cancelledCount: 1 });
      expect(transitions()).toEqual([{ callbackId: "cb-1", from: "SCHEDULED", to: "CANCELLED" }]);
      expect(logSpies.error).not.toHaveBeenCalled();
    });

    it("records in the log whether the schedule was actually deleted", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [record("cb-1"), record("cb-2")] });
      schedulerMock
        .on(DeleteScheduleCommand, { Name: "callback-cb-1" })
        .rejects(scheduleNotFound())
        .on(DeleteScheduleCommand, { Name: "callback-cb-2" })
        .resolves({});

      await makeService().cancelForPhoneNumber(PHONE);

      const lines = logSpies.log.mock.calls.map((c) => JSON.parse(String(c[0])));
      expect(lines).toContainEqual(expect.objectContaining({ callbackId: "cb-1", scheduleDeleted: false }));
      expect(lines).toContainEqual(expect.objectContaining({ callbackId: "cb-2", scheduleDeleted: true }));
    });
  });

  describe("failures", () => {
    it("keeps going after one callback fails, then reports the failure", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [record("cb-1"), record("cb-2"), record("cb-3")] });
      ddbMock.on(UpdateCommand, { Key: { callbackId: "cb-2" } }).rejects(new Error("ProvisionedThroughputExceededException"));

      await expect(makeService().cancelForPhoneNumber(PHONE)).rejects.toThrow(
        /Failed to cancel 1 of 3 callbacks \(2 cancelled\)/,
      );

      expect(deletedSchedules()).toEqual(["callback-cb-1", "callback-cb-3"]);
    });

    it("propagates an unexpected Scheduler error (not a not-found) as a failure", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [record("cb-1")] });
      schedulerMock.on(DeleteScheduleCommand).rejects(new Error("ThrottlingException"));

      await expect(makeService().cancelForPhoneNumber(PHONE)).rejects.toThrow(/1 cancelled/);
      // The record was still marked CANCELLED before the delete was attempted.
      expect(transitions()).toEqual([{ callbackId: "cb-1", from: "SCHEDULED", to: "CANCELLED" }]);
    });

    it("masks the number in log lines", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [record("cb-1")] });

      await makeService().cancelForPhoneNumber(PHONE);

      const line = JSON.parse(String(logSpies.log.mock.calls[0][0]));
      expect(line.phone).toBe("*********0123");
    });
  });
});
