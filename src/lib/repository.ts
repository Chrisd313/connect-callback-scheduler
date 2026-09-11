import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { CallbackRecord, CallbackStatus } from "./types.js";

const SOURCE_CONTACT_INDEX = "bySourceContactId";

export class CallbackRepository {
  constructor(
    private readonly tableName: string,
    private readonly doc: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({})),
  ) {}

  async get(callbackId: string): Promise<CallbackRecord | undefined> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { callbackId } }),
    );
    return result.Item as CallbackRecord | undefined;
  }

  async findBySourceContactId(sourceContactId: string): Promise<CallbackRecord | undefined> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: SOURCE_CONTACT_INDEX,
        KeyConditionExpression: "sourceContactId = :c",
        ExpressionAttributeValues: { ":c": sourceContactId },
        Limit: 1,
      }),
    );
    return result.Items?.[0] as CallbackRecord | undefined;
  }

  /** Inserts a new record. Throws if the callbackId already exists. */
  async create(record: CallbackRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: record,
        ConditionExpression: "attribute_not_exists(callbackId)",
      }),
    );
  }

  /**
   * Moves a callback from one status to another. Returns false if the record
   * wasn't in the expected status (e.g. it was cancelled or already dispatched).
   */
  async transitionStatus(
    callbackId: string,
    from: CallbackStatus,
    to: CallbackStatus,
    extra: Partial<Pick<CallbackRecord, "outboundContactId" | "failureReason">> = {},
    now: Date = new Date(),
  ): Promise<boolean> {
    const names: Record<string, string> = { "#status": "status", "#updatedAt": "updatedAt" };
    const values: Record<string, unknown> = {
      ":from": from,
      ":to": to,
      ":updatedAt": now.toISOString(),
    };
    const sets = ["#status = :to", "#updatedAt = :updatedAt"];

    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      names[`#${key}`] = key;
      values[`:${key}`] = value;
      sets.push(`#${key} = :${key}`);
    }

    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { callbackId },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: "#status = :from",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw err;
    }
  }
}
