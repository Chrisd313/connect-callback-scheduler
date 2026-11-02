# connect-callback-scheduler

Lets customers in an Amazon Connect queue choose a callback instead of waiting on hold.

## How it works

```
Inbound call ──▶ "Offer callback" contact flow
                        │  Invoke Lambda
                        ▼
              createCallback Lambda ──▶ DynamoDB (connect-callbacks-<env>)
                        │
                        ▼
              EventBridge Scheduler one-time schedule  at(<scheduledFor>)
                        │
                        ▼
              dispatchCallback Lambda ──▶ Connect StartOutboundVoiceContact
                        │                 (placed into the original queue)
                        │ transient error?
                        ▼
              new one-time schedule  at(now + retry delay)  ──▶ dispatchCallback again
```

1. The contact flow collects (or defaults) the callback number and an optional preferred time, then invokes `createCallback`.
2. `createCallback` validates the number, works out the callback time (within callback hours, see below), stores a `SCHEDULED` record and creates a one-time schedule. It returns a flat map that the flow branches on via `result` (`SCHEDULED`, `INVALID`, `ERROR`).
3. At the scheduled time, Scheduler invokes `dispatchCallback`, which claims the record (`DISPATCHING`), starts the outbound call and moves the record to `DISPATCHED`. If Connect returns a transient error it schedules its own retry instead (see "Dispatch retries").
4. If the customer rings back in first, the inbound flow can invoke `cancelCallback`, which moves every `SCHEDULED` callback for their number to `CANCELLED` and deletes the schedules.

### Callback statuses

| Status        | Meaning                                                                                   |
|---------------|-------------------------------------------------------------------------------------------|
| `SCHEDULED`   | A one-time schedule will fire `dispatchCallback`: either the original (`attempts` 0) or a retry after a transient Connect error (`attempts` > 0, `failureReason` holds the last error). The only status a cancel acts on. |
| `DISPATCHING` | `dispatchCallback` has claimed the record and is placing the outbound call. Normally lasts milliseconds. |
| `DISPATCHED`  | Connect accepted the outbound call. `outboundContactId` and `attempts` are set.           |
| `FAILED`      | The Connect request errored permanently, or transiently with no attempts left. `failureReason` holds the final error, `attempts` how many were made. Raises the alarm. |
| `CANCELLED`   | Cancelled from `SCHEDULED` before any call was placed.                                    |

Dispatch and cancel can run at the same time, so both use conditional updates on `status`
and exactly one of them wins:

- `dispatchCallback` moves `SCHEDULED -> DISPATCHING` **before** it calls Connect. If that
  update fails the record was cancelled (or claimed by a duplicate invocation) and no call
  is placed.
- `cancelCallback` moves `SCHEDULED -> CANCELLED`. If that update fails the dispatch has
  already committed to calling, and the callback is not reported as cancelled.

A dispatch that finds the record already `DISPATCHING` does **not** call again, whether the
earlier invocation is still running (a duplicate delivery) or died between claiming the
record and recording the outcome (for example a Lambda timeout with the Connect call in
flight). We can't tell whether the customer's phone rang, and a missed callback is
preferable to calling a customer twice, so it logs a warning with the claim's age
(`claimAgeSeconds`) and leaves the record alone. A record that stays `DISPATCHING` is a
stale claim; recovering those is deliberately not attempted yet and is tracked as CCB-156.
CloudWatch Logs Insights can find them with
`filter message like /claimed by an earlier dispatch/`.

### Dispatch retries

`StartOutboundVoiceContact` can fail for reasons that clear on their own (throttling, a
Connect-side error, a dropped connection). `dispatchCallback` retries those itself, a
bounded number of times, and gives up on errors that would fail the same way every time.

**Mechanism.** On a transient error, while the record is still `DISPATCHING`, the handler:

1. creates a new one-time schedule `callback-<id>-retry-<n>` for `now + DISPATCH_RETRY_DELAY_SECONDS`,
   targeting itself with the same `{ callbackId }` payload;
2. releases the claim with a conditional `DISPATCHING -> SCHEDULED` update that records
   `attempts: n` and the error in `failureReason`;
3. logs `Callback dispatch failed, retry scheduled` (warn) and returns normally.

The retry schedule then invokes the handler exactly as the original did: it reads the
record, claims it, and calls Connect again with the **same `ClientToken`** (the
`callbackId`). Between attempts the record is `SCHEDULED`, so `cancelCallback` treats it
like any other pending callback; it derives the schedule name from `attempts` so it deletes
the right one.

Retries are scheduled in that order on purpose. If the schedule is created but the release
fails, the record is a stale `DISPATCHING` claim that the schedule will fire into and log
(see "Callback statuses"). The other order could leave a `SCHEDULED` record with nothing to
fire it, which nothing would ever report. If the schedule itself can't be created, the
record goes `FAILED` with both reasons and the alarm fires.

**What triggers a retry, and what doesn't.** Only the schedule the handler creates. We do
not rely on EventBridge Scheduler's `RetryPolicy` or on Lambda's built-in retries, for two
reasons:

- As we understand it, Scheduler invokes Lambda targets **asynchronously**. Its
  `RetryPolicy` (still set to 3 attempts / 15 minutes on every schedule) covers failing to
  hand the event to the Lambda service, not the function failing afterwards. A function
  error or timeout is retried by Lambda's asynchronous-invocation retry instead: at most
  two more attempts, roughly a minute then two minutes later, not configurable beyond that.
  Treat that description as our reading of AWS's behaviour, not something this repo tests.
- Whichever layer retries, it re-runs the whole invocation, so the old code's "mark `FAILED`
  and rethrow" could never work: the retry found `FAILED` and skipped.

So a **handled** Connect outcome, retry scheduled or final failure, does **not** throw; the
handler has dealt with it. The handler still throws on infrastructure errors (DynamoDB,
Scheduler), because there an invoker-level retry of the whole invocation can help, and
every path through the handler is idempotent on `status`, so an unexpected duplicate
invocation is harmless whichever layer produces it.

**Transient or permanent** is decided by `src/lib/connectErrors.ts`: throttling and limit
errors, `InternalServiceException`, HTTP 408/429/5xx, and anything with no HTTP response at
all (timeouts, socket errors) are transient. `InvalidParameterException` (for example a bad
destination number), `InvalidRequestException`, `ResourceNotFoundException`,
`DestinationNotAllowedException`, `OutboundContactNotPermittedException` and other 4xx
errors are permanent and go straight to `FAILED`. Unknown errors count as transient: with
attempts bounded, a wrong "transient" costs a couple of minutes, a wrong "permanent" costs
the customer their callback.

**No second call.** Our own state machine guarantees one *attempt* at a time and never an
attempt against a record that is `DISPATCHED`, `FAILED` or `CANCELLED`. For a transient
error where Connect may in fact have placed the call (a timeout or 5xx after the request
arrived), that guarantee rests on Connect's documented `ClientToken` idempotency: the retry
sends the same token and Connect returns the existing contact rather than dialling again.

**Configuration** (see the parameter table under "Callback hours" for the pattern):

| SAM parameter               | Env var                        | Default | Notes                                              |
|-----------------------------|--------------------------------|---------|----------------------------------------------------|
| `DispatchMaxAttempts`       | `DISPATCH_MAX_ATTEMPTS`        | `3`     | Total attempts, first try included. `1` turns retries off. |
| `DispatchRetryDelaySeconds` | `DISPATCH_RETRY_DELAY_SECONDS` | `60`    | Fixed delay before each retry.                     |
| `AlarmNotificationTopicArn` | n/a                            | empty   | SNS topic for the final-failure alarm. Empty means the alarm exists with no actions. |

Both are validated at startup like the callback-hours settings: a bad value fails every
dispatch invocation with a clear error rather than silently retrying forever or never.

**Visibility.** A final failure logs `Callback dispatch failed permanently` at error level
with `callbackId`, `attempt`, `maxAttempts`, `retryable` and `error`. The SAM template
turns that line into a `DispatchFinalFailures` metric (`ConnectCallbacks/<env>`) and the
`connect-callbacks-<env>-dispatch-final-failures` alarm (any occurrence in five minutes).
Logs Insights: `filter message = "Callback dispatch failed permanently"`.

**Not covered.** Retries are about the request to Connect. A call that Connect placed but
the customer didn't answer is `DISPATCHED` and is not retried (CCB-155). Retries don't
re-check callback hours: a retry a minute or two after the original time is close enough
that moving it would surprise the customer more than help.

### Contact flow parameters

| Parameter       | Required | Notes                                                                 |
|-----------------|----------|-----------------------------------------------------------------------|
| `callbackNumber`| No       | Defaults to the caller's number (`CustomerEndpoint.Address`).          |
| `queueId`       | No       | Defaults to the queue the contact is currently in.                    |
| `preferredTime` | No       | ISO-8601 with offset. If omitted we call back after the default delay. |

### Response

| Field               | When        | Notes                                                                      |
|---------------------|-------------|----------------------------------------------------------------------------|
| `result`            | Always      | `SCHEDULED`, `INVALID` or `ERROR`.                                         |
| `callbackId`        | `SCHEDULED` |                                                                            |
| `scheduledFor`      | `SCHEDULED` | ISO-8601 UTC.                                                              |
| `scheduledForLocal` | `SCHEDULED` | UK local time for text-to-speech, e.g. `Monday 2 November at 08:00`.       |
| `reason`            | `INVALID`   | `MISSING_DETAILS`, `OUTSIDE_CALLBACK_HOURS`, `TOO_FAR_AHEAD`, or a message. |
| `reason`            | `ERROR`     | `INTERNAL_ERROR`.                                                          |

### Callback hours

Callbacks are only scheduled when agents are available. The defaults are:

- Monday to Friday 08:00-20:00, Saturday 09:00-13:00, Sunday closed (Europe/London).
- England and Wales bank holidays closed. The list is static (2026 and 2027 at present) and
  needs extending each year from <https://www.gov.uk/bank-holidays.json>; we deliberately
  don't call gov.uk at runtime.
- The last 15 minutes before close count as closed, so agents aren't handed a callback
  as they leave.

The defaults are compiled in from `src/lib/defaultCallbackHours.ts`, and each can be
overridden per environment with a SAM parameter. Leave a parameter empty to keep the default.

| SAM parameter                  | Env var                           | Format / example                                  |
|--------------------------------|-----------------------------------|---------------------------------------------------|
| `CallbackHours`                | `CALLBACK_HOURS`                  | `mon-fri=08:00-20:00,sat=09:00-13:00`. Days not listed are closed; ranges may wrap (`sat-mon`). |
| `CallbackClosedDates`          | `CALLBACK_CLOSED_DATES`           | `2026-01-01,2026-04-03,...`. Replaces the built-in list entirely. |
| `CallbackTimeZone`             | `CALLBACK_TIMEZONE`               | IANA zone, e.g. `Europe/London`.                  |
| `CallbackClosingBufferMinutes` | `CALLBACK_CLOSING_BUFFER_MINUTES` | Whole minutes, e.g. `15`.                         |
| `MaxBookingDaysAhead`          | `MAX_BOOKING_DAYS_AHEAD`          | Whole days, default `7`.                          |

For example, to extend Saturdays in prod without a code change:

```bash
sam deploy --parameter-overrides \
  Environment=prod \
  CallbackHours="mon-fri=08:00-20:00,sat=09:00-17:00"
```

Values are validated when the Lambda starts (`src/lib/callbackHoursConfig.ts`). A malformed
value makes every `createCallback` invocation return `ERROR` with the cause in the logs,
which is deliberate: a typo should be loud, not quietly close a day. Lambda caps all
environment variables at 4 KB combined, which is plenty for several years of closed dates.

How a request is resolved:

- **No preferred time**: `now + DEFAULT_CALLBACK_DELAY_MINUTES`. If that is outside
  callback hours, the callback is scheduled for the next opening time instead.
- **Preferred time**: honoured exactly if it's within callback hours and no more than
  `MAX_BOOKING_DAYS_AHEAD` (default 7) days away. Otherwise we return `INVALID` with
  `reason` `OUTSIDE_CALLBACK_HOURS` or `TOO_FAR_AHEAD` so the flow can ask for another
  time; we never silently move a time the customer chose.

All of this is evaluated in UK local time and then converted back to UTC for EventBridge
Scheduler, so the schedule expression is correct either side of the BST clock changes.

### cancelCallback

Invoked from the inbound flow ("you have a callback booked, press 1 to cancel it").

| Parameter        | Required | Notes                                                        |
|------------------|----------|--------------------------------------------------------------|
| `callbackNumber` | No       | Defaults to the caller's number (`CustomerEndpoint.Address`). Any UK format. |

| Field            | When                                | Notes                                               |
|------------------|-------------------------------------|-----------------------------------------------------|
| `result`         | Always                              | `CANCELLED`, `NONE_FOUND`, `INVALID` or `ERROR`.    |
| `cancelledCount` | `CANCELLED`, `NONE_FOUND`, some `ERROR` | Number of callbacks cancelled, as a string. Present on `ERROR` only when the failure was a status update (see below); absent when we failed before attempting any, e.g. the lookup itself. |
| `reason`         | `INVALID`, `ERROR`                  | `MISSING_DETAILS`, `INTERNAL_ERROR`, or a message.  |

What counts as success: a callback is cancelled once its record is `CANCELLED`. Deleting
the schedule is best-effort after that. If the delete fails (throttling, say) the callback
still counts, the result is still `CANCELLED`, and an error is logged with the `callbackId`;
the schedule will fire into a `CANCELLED` record and `dispatchCallback` skips it. Only a
failed status update makes the result `ERROR`.

With several callbacks, every one is attempted even if an earlier one fails. If any status
update failed the result is `ERROR` (with `cancelledCount` for the ones that did go through),
not `CANCELLED`: a callback whose update failed is most likely still `SCHEDULED` and will
ring, so `CANCELLED` would be a false promise. The flow should invite the customer to try
again; the retry only sees what is still `SCHEDULED`.

One caveat on that retry. A thrown status update doesn't prove the write didn't apply (a
DynamoDB timeout can arrive after the write landed). In that case the retry finds nothing
`SCHEDULED` and returns `NONE_FOUND` for a callback that was in fact cancelled. Known and
not handled yet.

Only `SCHEDULED` callbacks are affected; `DISPATCHING`, `DISPATCHED`, `FAILED` and `CANCELLED`
ones are left alone. Each record is marked `CANCELLED` with a conditional update before its
schedule is deleted; a schedule that has already fired and deleted itself is not an error
either. The lookup uses the `byPhoneNumberStatus` index (`phoneNumber` + `status`), so it
reads only the pending rows for that number.

Log lines to know about: `Callback cancelled but its schedule could not be deleted` (error,
with `callbackId`), and `scheduleDeleteFailures` on the `Cancel request handled` info line.

If a dispatch is racing the cancel, whichever conditional update lands first wins (see
"Callback statuses"). A consequence is that a customer who presses cancel at the moment
their callback is being placed gets `NONE_FOUND`, not `CANCELLED`, and their phone will
ring: the flow can't currently distinguish "nothing booked" from "we're calling you now".

### Idempotency

- Contact flows can retry a Lambda invoke on timeout, so `createCallback` looks up existing records by `sourceContactId` (GSI `bySourceContactId`) and returns the existing callback instead of creating a second one.
- `dispatchCallback` claims the record with a conditional `SCHEDULED -> DISPATCHING` update before calling Connect, so a duplicate or retried invocation never places a second call. Every attempt passes `callbackId` as the Connect `ClientToken`, so a retry of a request that did reach Connect is treated by Connect as the same request.

## Project layout

```
src/
  handlers/          Lambda entry points (thin; wire up dependencies)
  lib/
    callbackService  Create-callback business logic
    cancelCallbackService  Cancel-pending-callbacks business logic
    callbackTime     Works out when to call back; Scheduler expression formatting
    connectErrors    Transient-or-permanent classification of StartOutboundVoiceContact errors
    callbackHours    Open/closed and next-opening logic over a CallbackHours table
    callbackHoursConfig   Builds the CallbackHours table from environment variables
    defaultCallbackHours  The built-in UK hours and bank holiday dates (data only)
    localTime        Intl-based UK local time conversion and readback formatting
    repository       DynamoDB access
    scheduler        EventBridge Scheduler wrapper
    validation       Phone number and preferred-time parsing
test/                Vitest unit tests (AWS SDK mocked with aws-sdk-client-mock)
template.yaml        SAM / CloudFormation
```

## Development

```bash
npm install
npm test           # unit tests
npm run typecheck
npm run build      # emits dist/ for SAM packaging
```

Tests don't need AWS credentials; SDK clients are mocked.

## Deploying

The pipeline runs `npm ci && npm test && npm run build`, then `sam deploy` per environment with `ConnectInstanceId` and `OutboundContactFlowId` overrides.

The template now declares the dispatch function's log group explicitly (the final-failure
metric filter needs a resource to attach to). On an environment deployed before that
change, Lambda will already have auto-created `/aws/lambda/connect-dispatch-callback-<env>`
and CloudFormation will fail to create it. Delete the auto-created group (or import it
into the stack) before the first deploy of this version.
