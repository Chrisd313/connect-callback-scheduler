import { ConnectClient, StartOutboundVoiceContactCommand } from "@aws-sdk/client-connect";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handler, setDepsForTesting } from "../src/handlers/dispatchCallback.js";
import type { AppConfig } from "../src/lib/config.js";
import { DEFAULT_CALLBACK_HOURS } from "../src/lib/defaultCallbackHours.js";
import { CallbackRepository } from "../src/lib/repository.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const connectMock = mockClient(ConnectClient);

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
};

const scheduledRecord = {
  callbackId: "cb-123",
  sourceContactId: "contact-1",
  phoneNumber: "+447700900123",
  queueId: "queue-1",
  scheduledFor: "2026-11-02T10:15:00.000Z",
  status: "SCHEDULED",
};

describe("dispatchCallback handler", () => {
  beforeEach(() => {
    ddbMock.reset();
    connectMock.reset();
    setDepsForTesting({
      config,
      repository: new CallbackRepository(
        config.tableName,
        DynamoDBDocumentClient.from(new DynamoDBClient({})),
      ),
      connect: new ConnectClient({}),
    });
  });

  afterAll(() => setDepsForTesting(undefined));

  it("starts an outbound call into the original queue and marks it DISPATCHED", async () => {
    ddbMock.on(GetCommand).resolves({ Item: scheduledRecord });
    ddbMock.on(UpdateCommand).resolves({});
    connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: "outbound-1" });

    await handler({ callbackId: "cb-123" });

    const call = connectMock.commandCalls(StartOutboundVoiceContactCommand)[0].args[0].input;
    expect(call).toMatchObject({
      InstanceId: "instance-1",
      ContactFlowId: "flow-1",
      QueueId: "queue-1",
      DestinationPhoneNumber: "+447700900123",
      ClientToken: "cb-123",
    });

    const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ExpressionAttributeValues).toMatchObject({
      ":from": "SCHEDULED",
      ":to": "DISPATCHED",
      ":outboundContactId": "outbound-1",
    });
  });

  it.each(["DISPATCHED", "CANCELLED", "FAILED"])("does nothing when the callback is %s", async (status) => {
    ddbMock.on(GetCommand).resolves({ Item: { ...scheduledRecord, status } });

    await handler({ callbackId: "cb-123" });

    expect(connectMock.commandCalls(StartOutboundVoiceContactCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("does nothing for an unknown callback", async () => {
    ddbMock.on(GetCommand).resolves({});

    await handler({ callbackId: "missing" });

    expect(connectMock.commandCalls(StartOutboundVoiceContactCommand)).toHaveLength(0);
  });

  it("marks the callback FAILED and rethrows when Connect errors", async () => {
    ddbMock.on(GetCommand).resolves({ Item: scheduledRecord });
    ddbMock.on(UpdateCommand).resolves({});
    connectMock.on(StartOutboundVoiceContactCommand).rejects(new Error("ThrottlingException"));

    await expect(handler({ callbackId: "cb-123" })).rejects.toThrow("ThrottlingException");

    const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ExpressionAttributeValues).toMatchObject({
      ":to": "FAILED",
      ":failureReason": "ThrottlingException",
    });
  });
});
