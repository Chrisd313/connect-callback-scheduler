import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { CreateScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { CallbackService } from "../src/lib/callbackService.js";
import { DEFAULT_CALLBACK_HOURS } from "../src/lib/defaultCallbackHours.js";
import { CallbackRepository } from "../src/lib/repository.js";
import { CallbackScheduler } from "../src/lib/scheduler.js";
import { ValidationError } from "../src/lib/validation.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const schedulerMock = mockClient(SchedulerClient);

// Monday 2 November 2026, 10:00 GMT: comfortably inside callback hours.
const NOW = new Date("2026-11-02T10:00:00Z");

function makeService(now: Date = NOW): CallbackService {
  return new CallbackService({
    repository: new CallbackRepository(
      "callbacks-test",
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
    ),
    scheduler: new CallbackScheduler(
      {
        dispatchFunctionArn: "arn:aws:lambda:eu-west-2:111111111111:function:dispatch",
        schedulerRoleArn: "arn:aws:iam::111111111111:role/scheduler",
        scheduleGroupName: "connect-callbacks-test",
      },
      new SchedulerClient({}),
    ),
    defaultCallbackDelayMinutes: 15,
    maxBookingDaysAhead: 7,
    callbackHours: DEFAULT_CALLBACK_HOURS,
    recordRetentionDays: 30,
    clock: () => now,
    idGenerator: () => "cb-123",
  });
}

describe("CallbackService.createCallback", () => {
  beforeEach(() => {
    ddbMock.reset();
    schedulerMock.reset();
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    schedulerMock.on(CreateScheduleCommand).resolves({});
  });

  it("stores a SCHEDULED record and creates a one-time schedule after the default delay", async () => {
    const result = await makeService().createCallback({
      sourceContactId: "contact-1",
      phoneNumber: "07700 900123",
      queueId: "queue-1",
    });

    expect(result).toEqual({
      callbackId: "cb-123",
      scheduledFor: "2026-11-02T10:15:00.000Z",
      scheduledForLocal: "Monday 2 November at 10:15",
      alreadyExisted: false,
    });

    const put = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(put.Item).toMatchObject({
      callbackId: "cb-123",
      sourceContactId: "contact-1",
      phoneNumber: "+447700900123",
      queueId: "queue-1",
      status: "SCHEDULED",
      attempts: 0,
      scheduledFor: "2026-11-02T10:15:00.000Z",
      expiresAt: Math.floor(NOW.getTime() / 1000) + 30 * 86_400,
    });
    expect(put.ConditionExpression).toBe("attribute_not_exists(callbackId)");

    const schedule = schedulerMock.commandCalls(CreateScheduleCommand)[0].args[0].input;
    expect(schedule).toMatchObject({
      Name: "callback-cb-123",
      GroupName: "connect-callbacks-test",
      ScheduleExpression: "at(2026-11-02T10:15:00)",
      ScheduleExpressionTimezone: "UTC",
      ActionAfterCompletion: "DELETE",
    });
    expect(JSON.parse(schedule.Target!.Input!)).toEqual({ callbackId: "cb-123" });
  });

  it("honours the customer's preferred time", async () => {
    const result = await makeService().createCallback({
      sourceContactId: "contact-1",
      phoneNumber: "+447700900123",
      queueId: "queue-1",
      preferredTime: "2026-11-02T16:00:00Z",
    });

    expect(result.scheduledFor).toBe("2026-11-02T16:00:00.000Z");
    expect(schedulerMock.commandCalls(CreateScheduleCommand)[0].args[0].input.ScheduleExpression).toBe(
      "at(2026-11-02T16:00:00)",
    );
  });

  it("returns the existing callback when the same contact asks twice", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          callbackId: "cb-existing",
          sourceContactId: "contact-1",
          scheduledFor: "2026-11-02T10:12:00.000Z",
        },
      ],
    });

    const result = await makeService().createCallback({
      sourceContactId: "contact-1",
      phoneNumber: "+447700900123",
      queueId: "queue-1",
    });

    expect(result).toEqual({
      callbackId: "cb-existing",
      scheduledFor: "2026-11-02T10:12:00.000Z",
      scheduledForLocal: "Monday 2 November at 10:12",
      alreadyExisted: true,
    });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(0);
  });

  it("rejects an invalid phone number without writing anything", async () => {
    await expect(
      makeService().createCallback({
        sourceContactId: "contact-1",
        phoneNumber: "12345",
        queueId: "queue-1",
      }),
    ).rejects.toThrow(ValidationError);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(0);
  });

  it("moves an out-of-hours default callback to the next opening", async () => {
    // Monday 21:40 GMT -> Tuesday 08:00 GMT
    const result = await makeService(new Date("2026-11-02T21:40:00Z")).createCallback({
      sourceContactId: "contact-1",
      phoneNumber: "+447700900123",
      queueId: "queue-1",
    });

    expect(result.scheduledFor).toBe("2026-11-03T08:00:00.000Z");
    expect(result.scheduledForLocal).toBe("Tuesday 3 November at 08:00");
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({
      scheduledFor: "2026-11-03T08:00:00.000Z",
    });
    expect(schedulerMock.commandCalls(CreateScheduleCommand)[0].args[0].input.ScheduleExpression).toBe(
      "at(2026-11-03T08:00:00)",
    );
  });

  it("creates the schedule in UTC when the opening time is in BST", async () => {
    // Saturday 28 March 2026 12:50 GMT (closing buffer) -> Monday 30 March 08:00 BST
    const result = await makeService(new Date("2026-03-28T12:50:00Z")).createCallback({
      sourceContactId: "contact-1",
      phoneNumber: "+447700900123",
      queueId: "queue-1",
    });

    expect(result.scheduledFor).toBe("2026-03-30T07:00:00.000Z");
    expect(result.scheduledForLocal).toBe("Monday 30 March at 08:00");

    const schedule = schedulerMock.commandCalls(CreateScheduleCommand)[0].args[0].input;
    expect(schedule.ScheduleExpression).toBe("at(2026-03-30T07:00:00)");
    expect(schedule.ScheduleExpressionTimezone).toBe("UTC");
  });

  it("reads back a BST preferred time in local time", async () => {
    const result = await makeService(new Date("2026-07-01T10:00:00Z")).createCallback({
      sourceContactId: "contact-1",
      phoneNumber: "+447700900123",
      queueId: "queue-1",
      preferredTime: "2026-07-02T13:30:00Z",
    });

    expect(result.scheduledFor).toBe("2026-07-02T13:30:00.000Z");
    expect(result.scheduledForLocal).toBe("Thursday 2 July at 14:30");
  });

  it("rejects a preferred time outside callback hours without writing anything", async () => {
    await expect(
      makeService().createCallback({
        sourceContactId: "contact-1",
        phoneNumber: "+447700900123",
        queueId: "queue-1",
        preferredTime: "2026-11-08T10:00:00Z", // Sunday
      }),
    ).rejects.toMatchObject({ name: "ValidationError", code: "OUTSIDE_CALLBACK_HOURS" });

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(0);
  });

  it("rejects a preferred time more than 7 days ahead without writing anything", async () => {
    await expect(
      makeService().createCallback({
        sourceContactId: "contact-1",
        phoneNumber: "+447700900123",
        queueId: "queue-1",
        preferredTime: "2026-11-10T10:00:00Z",
      }),
    ).rejects.toMatchObject({ name: "ValidationError", code: "TOO_FAR_AHEAD" });

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(schedulerMock.commandCalls(CreateScheduleCommand)).toHaveLength(0);
  });
});
