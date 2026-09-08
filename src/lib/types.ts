export type CallbackStatus = "SCHEDULED" | "DISPATCHED" | "FAILED" | "CANCELLED";

export interface CallbackRecord {
  callbackId: string;
  /** Contact ID of the inbound call that requested the callback. Used for idempotency. */
  sourceContactId: string;
  phoneNumber: string;
  queueId: string;
  /** ISO-8601 UTC timestamp the callback is scheduled for. */
  scheduledFor: string;
  status: CallbackStatus;
  createdAt: string;
  updatedAt: string;
  outboundContactId?: string;
  failureReason?: string;
  /** Epoch seconds, used by DynamoDB TTL. */
  expiresAt: number;
}

export interface CreateCallbackResult {
  callbackId: string;
  scheduledFor: string;
  alreadyExisted: boolean;
}

/** Payload EventBridge Scheduler sends to the dispatch Lambda. */
export interface DispatchEvent {
  callbackId: string;
}
