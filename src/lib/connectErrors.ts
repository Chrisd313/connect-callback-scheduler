/**
 * Decides whether a StartOutboundVoiceContact failure is worth retrying.
 *
 * Transient: Connect (or the network) stopped us this time, but the same request could
 * work in a minute. Permanent: the request itself is wrong and will fail the same way
 * every time, so retrying only delays telling ops.
 *
 * Anything we can't classify is treated as transient: attempts are bounded, so a wrong
 * "transient" costs a couple of minutes, whereas a wrong "permanent" costs the customer
 * their callback.
 *
 * Some transient errors (timeouts, connection resets, 5xx) leave it unknown whether
 * Connect actually placed the call. The retry resends the same ClientToken (the
 * callbackId), which Connect documents as making the request idempotent, and that is
 * what prevents a second call in those cases.
 */

const TRANSIENT_NAMES = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "LimitExceededException", // e.g. concurrent outbound call limit; frees up over time
  "ServiceQuotaExceededException",
  "InternalServiceException",
  "ServiceUnavailableException",
  "RequestTimeout",
  "RequestTimeoutException",
  "TimeoutError",
]);

const PERMANENT_NAMES = new Set([
  "InvalidParameterException", // e.g. malformed destination number
  "InvalidRequestException",
  "ResourceNotFoundException", // instance, queue or contact flow id
  "DestinationNotAllowedException", // number not permitted by the instance's outbound rules
  "OutboundContactNotPermittedException",
  "AccessDeniedException",
  "InvalidContactFlowException",
  "ContactFlowNotPublishedException",
]);

interface SdkErrorShape {
  name?: string;
  $fault?: "client" | "server";
  $retryable?: unknown;
  $metadata?: { httpStatusCode?: number };
}

export function isTransientConnectError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return true;
  const e = err as SdkErrorShape;

  if (e.name && TRANSIENT_NAMES.has(e.name)) return true;
  if (e.name && PERMANENT_NAMES.has(e.name)) return false;

  if (e.$retryable) return true;
  if (e.$fault === "server") return true;

  const status = e.$metadata?.httpStatusCode;
  if (status !== undefined) {
    if (status === 408 || status === 429 || status >= 500) return true;
    if (status >= 400) return false;
  }
  if (e.$fault === "client") return false;

  // No status, no fault: the request never got a response (DNS, socket, timeout).
  return true;
}
