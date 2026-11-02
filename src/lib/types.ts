/**
 * Lifecycle of a callback record.
 *
 *   SCHEDULED   A one-time schedule will invoke dispatchCallback. Either freshly created
 *               (attempts 0) or waiting for a retry after a transient Connect error
 *               (attempts > 0, failureReason holds the last error).
 *   DISPATCHING dispatchCallback has claimed the record and is placing the outbound call.
 *               Claimed with a conditional update *before* the Connect call, so a cancel
 *               that lands after the claim fails and a cancel that lands before it stops
 *               the call. Normally lasts milliseconds; a record left here means the
 *               dispatch invocation is still running or died mid-call (see README,
 *               "Callback statuses").
 *   DISPATCHED  Connect accepted the outbound call; outboundContactId is set.
 *   FAILED      The StartOutboundVoiceContact request errored permanently, or transiently
 *               with no attempts left; failureReason holds the final error.
 *   CANCELLED   cancelCallback moved it here from SCHEDULED before any call was placed.
 *
 * Only SCHEDULED can be cancelled. Only SCHEDULED can be dispatched.
 */
export type CallbackStatus = "SCHEDULED" | "DISPATCHING" | "DISPATCHED" | "FAILED" | "CANCELLED";

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
  /** Most recent Connect error. Final on FAILED; the last transient error on a SCHEDULED retry. */
  failureReason?: string;
  /**
   * Connect attempts made so far. Absent on records created before retries existed, which
   * reads as 0. The pending schedule for a record with attempts n is named by
   * CallbackScheduler.scheduleName(callbackId, n).
   */
  attempts?: number;
  /** Epoch seconds, used by DynamoDB TTL. */
  expiresAt: number;
}

export interface CreateCallbackResult {
  callbackId: string;
  /** ISO-8601 UTC. */
  scheduledFor: string;
  /** Contact-centre local time for text-to-speech readback, e.g. "Monday 2 November at 08:00". */
  scheduledForLocal: string;
  alreadyExisted: boolean;
}

/** Payload EventBridge Scheduler sends to the dispatch Lambda. */
export interface DispatchEvent {
  callbackId: string;
}
