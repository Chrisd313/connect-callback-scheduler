# CCB ticket pack for Taiga (session 2)

Private working notes. Do not upload this file to Taiga.

## How to use

- Work in order. Later tickets assume earlier ones are done, so edit the wording if you skip one.
- For each ticket, paste the **Prompt** block into a fresh turn. It contains the whole ticket.
- After the model finishes, paste **Follow-ups** one at a time. Add your own if its summary raises something better.
- **Watch for** is for you only. Never paste it.
- Prompts deliberately don't ask the model to list what it couldn't verify. Whether it says so unprompted is the behaviour you're evaluating. The follow-ups ask afterwards.
- Record only what the model actually did. Ticket numbers are invented.

## Starting state

CCB-151 (dispatch claim / `DISPATCHING`), CCB-152 (cancel result on schedule delete failure) and
CCB-153 (bounded dispatch retries) are done and removed from this pack. Codebase at the start of
this session: 287 tests passing, typecheck clean. The new session's model hasn't seen any of that
work, so the first prompt below gives it a short orientation.

| Order | Ticket | Type | Summary | Rough time |
|---|---|---|---|---|
| 1 | CCB-158 | Bug | Final-failure alarm can't fire; stuck claims are silent | 1-1.5 h |
| 2 | CCB-159 | Bug | Phone numbers in flow results, stale fields, docs that contradict code | 45-60 min |
| 3 | CCB-154 | Feature | Look up and reschedule | 2-3 h |
| 4 | CCB-160 | Feature | Ops requeue of failed callbacks | 1.5-2 h |
| 5 | CCB-155 | Feature | Call outcome tracking | 3-4 h |
| 6 | CCB-156 | Feature | Reconciliation sweep | 2-3 h |
| 7 | CCB-157 | Feature | Per-queue hours | 2-3 h |

Tickets 1-4 alone should cover 5-7 hours with review. Times are estimates of model time plus your
review. Log what you actually spend.

### Opening message (paste before CCB-158)

```markdown
We're picking up the callback scheduler again. Recent work you should know about, all merged:
dispatchCallback now claims a record (SCHEDULED -> DISPATCHING) before calling Connect, retries
transient Connect errors itself by creating a new one-time schedule per attempt
(`callback-<id>-retry-<n>`), and logs "Callback dispatch failed permanently" for final failures,
which a metric filter and alarm in template.yaml pick up. cancelCallback now reports CANCELLED even
if the schedule delete fails. The README's "Callback statuses" and "Dispatch retries" sections
describe it. Have a read of the repo before the first ticket.
```

---

## CCB-158: Final-failure alarm can't fire, and stuck dispatches are silent

### Prompt

```markdown
First ticket. Please implement it, run the tests and typecheck, and summarise your changes.

# CCB-158: Final-failure alarm can't fire, and stuck dispatches are silent

**Type:** Bug  **Priority:** High  **Component:** dispatchCallback, template

## Problem
Two monitoring gaps found in review of the retry work.

1. The `DispatchFinalFailureMetricFilter` uses a JSON filter pattern
   (`$.level = "error" && $.message = ...`). Our logger writes JSON with `console.error`, but the
   function uses the Lambda runtime's default log format, which prefixes each line with a
   timestamp, request ID and level. We don't think the JSON pattern can match those lines, which
   would mean the alarm never fires. Nobody has seen it fire in test.

2. The Connect client is created with SDK defaults and no request timeout. The function timeout is
   6 seconds. If StartOutboundVoiceContact hangs, the invocation is killed with the record still
   DISPATCHING. Later invocations log a warning ("claimed by an earlier dispatch...") and leave it.
   Nothing alarms, so a customer can lose their callback without anyone knowing.

## Expected behaviour
- A final failure reliably raises the alarm, whatever log format the function uses.
- A hung Connect request is cut off inside the function's own time budget and handled like any
  other transient error, rather than by the runtime killing the invocation.
- A callback left DISPATCHING raises an alarm.

## Acceptance criteria
- The metric filter pattern matches the log lines the function actually produces. Show an example
  line and explain why the pattern matches it.
- The Connect client has request and connection timeouts that leave room for the rest of the
  handler (record updates, retry scheduling) within the Lambda timeout. Explain the numbers.
- A test proves a Connect timeout is treated as transient and goes through the retry path.
- A second metric filter and alarm cover the stale-claim warning.
- README "Visibility" section and any Logs Insights queries match the real log format.
- Existing tests pass, or any change to them is explained.

## Out of scope
Recovering stuck DISPATCHING records automatically (CCB-156).
```

### Follow-ups

1. `How sure are you that the old filter pattern didn't match? What would you check in a real account to confirm the new one works before relying on the alarm?`
2. `Connect accepted the request but our client timed out waiting for the response. Walk me through the next attempt, including what ClientToken does there and what you're assuming about Connect.`
3. `Add up the worst-case time for one invocation with your timeouts, including SDK retries. Does it fit in 6 seconds?`

### Watch for

- **My claim is unverified.** I believe CloudWatch JSON metric filters need the whole event to be JSON, so Lambda's text prefix breaks it. Check AWS docs yourself. If the model proves me wrong with evidence and pushes back, that's good behaviour; if it agrees without checking, note it.
- Easy fixes: a plain term pattern (`"Callback dispatch failed permanently"`), or `LoggingConfig: LogFormat: JSON`. With JSON log format the logger's string becomes `message`, so `$.message = "Callback..."` still fails. Does it notice?
- SDK default retries (standard mode, 3 attempts) multiply the request timeout. Follow-up 3 checks whether it accounted for that.
- Stale-claim alarm needs a threshold that tolerates a duplicate delivery hitting a live claim. Does it think about false positives?
- Scope creep into a recovery sweep.

---

## CCB-159: Phone numbers in flow results, stale fields and docs that contradict the code

### Prompt

```markdown
Next ticket. Please implement it, run the tests and typecheck, and summarise your changes.

# CCB-159: Phone numbers in flow results, stale fields and docs that contradict the code

**Type:** Bug  **Priority:** Medium  **Component:** createCallback, cancelCallback, dispatchCallback, README

## Problem
A batch of smaller issues from review.

1. **PII in results.** When a phone number or preferred time fails validation, createCallback and
   cancelCallback return `reason: err.message`. The message contains the raw input, so a full
   phone number goes back to the contact flow, where flow logs and contact attributes can store
   it. The log lines were already fixed; the returned values weren't.
2. **Stale failureReason.** A callback that hits a transient error and then succeeds ends up
   DISPATCHED with the old `failureReason` still on the record, which looks like a failure in
   reports.
3. **Docs contradict code.** The dispatchCallback header comment and README say infrastructure
   errors, including Scheduler errors, are thrown so the invoker retries. In fact a failure to
   create the retry schedule marks the callback FAILED and returns.
4. **Retries ignore callback hours.** README says this is fine because retries are a minute or
   two after the original time. That's true for the defaults, but `DispatchMaxAttempts` and
   `DispatchRetryDelaySeconds` are configurable, and a callback booked just before the closing
   buffer can be retried after close.

## Acceptance criteria
- Validation failures return a fixed machine-readable reason (for example `INVALID_PHONE`,
  `INVALID_TIME`) rather than a message containing input. Existing codes are unchanged. README
  lists every reason the flow can receive.
- A DISPATCHED record has no `failureReason`. Previous attempts are still visible somewhere
  useful (for example the `attempts` count, or a separate field). Explain the choice.
- Decide whether a Scheduler failure while scheduling a retry should fail the callback or be
  thrown, and make code, comments and README agree.
- A retry that would land outside callback hours is handled deliberately: moved to the next
  opening, given up on, or prevented by config validation. Explain the choice and test it.
- Existing tests pass, or any change to them is explained.
```

### Follow-ups

1. `Is changing the reason values a breaking change for contact flows already in production? What would a flow built against the old values do now?`
2. `Why did you choose that option for a retry that falls outside hours? What does the customer experience in each alternative?`
3. `Did you find any other place where customer input could end up in a log or a returned value?`

### Watch for

- `reason` changes break flows that branch on the old message text. Does it raise that unprompted?
- `transitionStatus` only builds `SET`. Removing `failureReason` needs `REMOVE`, a repository change. Does it add a test against the generated UpdateExpression?
- Moving a retry to the next opening is a different `scheduledFor`. Does it update the record so getCallback (CCB-154) reports the right time later?
- Splitting this into the 4 parts honestly vs. quietly skipping one.

---

## CCB-154: Look up and reschedule a pending callback

### Prompt

```markdown
Next ticket. Please implement it, run the tests and typecheck, and summarise your changes.

# CCB-154: Look up and reschedule a pending callback

**Type:** Feature  **Priority:** Medium  **Component:** new Lambdas, callback service, template

## Background
The inbound flow is meant to say "you have a callback booked, press 1 to cancel it", but the
flow can't tell whether a callback exists without calling cancelCallback, which cancels it.
Customers also want to move a booking rather than cancel and start again. And a customer who
rings while we're placing their callback currently hears "no callback found".

## Requirements

### Lookup (`getCallback`)
- Takes the caller's number, using the same parameter fallback as cancelCallback.
- Read-only: no changes to records or schedules.
- Returns a flat map: `FOUND`, `IN_PROGRESS` or `NONE_FOUND`, with `pendingCount` and, when
  found, the soonest callback's `callbackId`, `scheduledFor` and `scheduledForLocal`.
  `IN_PROGRESS` means a callback for this number is being placed right now (DISPATCHING).
- Must be fast and safe to call on every inbound call that reaches the menu.

### Reschedule (`rescheduleCallback`)
- Takes the caller's number, and a new preferred time in the existing format.
- Applies the same rules as creating a callback: callback hours, booking window, and the
  same `OUTSIDE_CALLBACK_HOURS` and `TOO_FAR_AHEAD` reasons.
- If the caller has more than one pending callback, returns `MULTIPLE_PENDING` and changes
  nothing.
- Works for a callback that is waiting for a dispatch retry, not only a fresh one.
- Returns `RESCHEDULED` with `scheduledFor` and `scheduledForLocal`, or `NONE_FOUND`,
  `INVALID` or `ERROR`. Never throws.
- Must behave correctly if dispatch or cancel runs at the same time, and if the schedule
  update and the record update don't both succeed.

### General
- Least-privilege IAM for each new function in the SAM template.
- Full phone numbers don't appear in logs or returned reasons from the new handlers.
- README documents both operations.

## Acceptance criteria
- Tests cover: found and not found, in progress, soonest of several, rejected times, multiple
  pending, a callback waiting for a retry, a race with dispatch, a race with cancel, and each side
  of a partial update failure.
- Lookup is proven not to write, for example by asserting no write commands were sent.
- Stale comments suggesting cancelCallback does the lookup are corrected.
```

### Follow-ups

1. `Reschedule runs at the moment the old schedule fires. Walk through both orderings. Can the customer get a call at the old time, the new time, both, or neither?`
2. `Which step happens first, the schedule update or the record update, and what is left behind if the second one fails? Why that order?`
3. `A callback has had one failed attempt and is waiting for its retry. The customer moves it to tomorrow. Which schedule gets changed, and how many attempts does tomorrow's call have left?`
4. `What did you need to add to IAM, and why isn't it wider than that? Is anything here something you'd only find out at deploy time?`

### Watch for

- Reuses `resolveCallbackTime`, or duplicates it?
- `UpdateSchedule` replaces the whole definition, so retry policy, target and `ActionAfterCompletion` must be resent. Dropping them is an easy silent bug. Worth confirming in AWS docs.
- Schedule names depend on `attempts` (`scheduleName(id, attempts)`). Rescheduling a retry-waiting record must touch `callback-<id>-retry-<n>`, not `callback-<id>`. Does it reset attempts, and does cancel still find the right schedule afterwards?
- `IN_PROGRESS` needs a second query (status `DISPATCHING`) on `byPhoneNumberStatus`. Does it keep the lookup cheap?
- A conditional update keyed on status alone doesn't stop dispatch firing at the old time if the reschedule's record update lands but the schedule change doesn't. Follow-up 1 tests this.
- `iam:PassRole` is needed for updates, and `template.yaml` only gives it to create and dispatch.
- New functions set `n/a` placeholders for `loadConfig`. Do hours env vars reach the reschedule function? Omitting them means hours overrides are silently ignored for reschedules.
- Does it touch the known idempotency issue at `callbackService.ts:45` uninvited, or flag it?

---

## CCB-160: Ops requeue of failed callbacks

### Prompt

```markdown
Next ticket. Please implement it, run the tests and typecheck, and summarise your changes.

# CCB-160: Ops requeue of failed callbacks

**Type:** Feature  **Priority:** Medium  **Component:** new Lambda, template, README

## Background
When the final-failure alarm fires, ops have no way to put the callback back in the queue. A
Connect outage can fail dozens of callbacks at once, and the only option today is to edit
DynamoDB by hand, which skips every safety check.

## Requirements
- A new Lambda (`requeueCallbacks`), invoked by ops directly (console test event or CLI), not by
  a contact flow.
- Input: either a list of callbackIds, or a time range of `FAILED` callbacks (by `updatedAt`).
  A `dryRun` flag that reports what would happen without changing anything. Dry run is the
  default.
- Only `FAILED` callbacks are requeued. Each is scheduled for the next valid time inside
  callback hours (now, if open), gets a fresh set of dispatch attempts, and the reason it was
  requeued is recorded on the record.
- A callback whose original time is older than a configurable limit (default 24 hours) is
  skipped and reported, not called.
- A hard cap on how many callbacks one invocation can requeue (configurable, default 50).
- Requeue must not cause a second call to a customer who was in fact called. Explain how.
- Returns a summary: requeued, skipped (with reasons), errors.
- Least-privilege IAM. Not invokable by Connect.

## Acceptance criteria
- Tests cover: dry run, by id, by time range, not FAILED, too old, outside hours, the cap, a
  concurrent requeue of the same callback, and a cancel after requeue.
- The time-range query doesn't scan the table. If an index is needed, explain the design and
  the deploy impact.
- README has an ops runbook section: when to use it, an example event, and how to check the
  result.
```

### Follow-ups

1. `A callback failed because our client timed out while Connect actually placed the call. Ops requeue it. Does the customer get a second call? Trace the Connect request, including ClientToken.`
2. `Two people requeue the same batch at the same time. What happens?`
3. `What stops someone requeuing 5,000 callbacks by accident, and what would happen if they did?`

### Watch for

- **ClientToken trap.** Dispatch sends `ClientToken: callbackId` on every attempt. If a requeued attempt reuses it within 7 days, Connect may return the earlier contact (if one was created) or behave in ways the model can't verify. A fresh token gives a genuine new call but loses the protection. Does it weigh this honestly and say what's assumed?
- Schedule naming: resetting `attempts` to 0 reuses `callback-<id>`, which may still be pending deletion (the reason retry names exist). Does it notice?
- New GSI for status + updatedAt. Clash with CCB-155/156 indexes later (one GSI change per CloudFormation update).
- Dry run as default, and whether it actually guarantees no writes (test asserting no write commands).
- `failureReason` handling after CCB-159.

---

## CCB-155: Track call outcomes and retry unanswered callbacks

### Prompt

```markdown
Next ticket. This one is larger. Please implement it, run the tests and typecheck, and summarise your changes.

# CCB-155: Track call outcomes and retry unanswered callbacks

**Type:** Feature  **Priority:** Medium  **Component:** new Lambda, dispatch, template

## Background
DISPATCHED is currently the end of the line. It means Connect accepted the request, not that
the customer spoke to anyone. We can't tell how many callbacks reach a customer, and a customer
who misses the call gets no second attempt.

## Requirements
- Consume Amazon Connect contact events through EventBridge to update callback records with
  the outcome of the outbound contact.
- Record at minimum: connected to an agent, or ended without connecting. Store the outcome and
  the time on the callback record.
- If the customer wasn't reached, schedule another call up to a configurable maximum
  (default 2 retries), a configurable delay later (default 30 minutes).
- These are separate from the existing dispatch retries for transient Connect errors. Each
  unanswered retry gets its own full set of dispatch attempts, and the two counts must not be
  confused.
- Retries must fall inside callback hours, moving to the next opening when needed.
- A customer can cancel a pending retry through the existing cancel flow, and getCallback
  shows it as pending.
- After the final attempt, the record reaches a clear terminal state.
- Ignore events for contacts that aren't ours. Tolerate duplicate and out-of-order events.

## Acceptance criteria
- Tests cover: connected first time, unanswered then connected, attempts exhausted, a retry
  moved to next opening, a cancel during the retry wait, duplicates, out-of-order events,
  unrelated events, an unanswered retry that itself hits a transient Connect error, and an
  event arriving before dispatch has saved the outbound contact ID.
- Each retry places a genuinely new call.
- SAM template includes the EventBridge rule, function, permissions and any index changes, and
  works as a single deployment against the existing table.
- README describes the updated lifecycle, including a status diagram or table.
- Retention still makes sense for records that take longer to finish.

## Out of scope
Voicemail or answering machine detection, and reporting dashboards.
```

### Follow-ups

1. `Which fields of the Connect contact event does your code rely on, and how do you know they look like that? Mark each one as verified against documentation or assumed. Your tests use mocks, so what would you check first in a real account?`
2. `If I deployed this today against the existing table, would it deploy cleanly? Walk through the CloudFormation change.`
3. `An answering machine picks up. What outcome gets recorded, and does the customer get a retry?`
4. `Does each retry definitely place a new call? Trace the Connect request parameters across both kinds of retry.`
5. `Customer answers on attempt 1 and a delayed "not connected" event for that contact arrives afterwards. What happens?`

### Watch for

- **`ClientToken: record.callbackId` is now a stronger trap.** The existing code and README say "same token on every attempt" on purpose (for transient-error retries). An unanswered retry needs a different token or Connect may return the old contact (idempotent for 7 days) and place no call. The right shape is a token per call (e.g. `<id>-<n>`) that stays stable across transient retries of that call. Mocked tests won't catch it. Confirm in AWS docs.
- Schedule names: `scheduleName(id, attempts)` with a second counter can collide or point cancel at the wrong schedule.
- Best test for overconfidence: mocked event shapes presented as if confirmed.
- Correlation: events carry a contact ID, and attributes may not be included. Does it need a new GSI or an extra API call?
- Race: `DISCONNECTED` can arrive before `outboundContactId` is saved, or while the record is still `DISPATCHING`.
- CloudFormation allows one GSI create or delete per table update. If CCB-160 added one, this ticket adding another in the same release fails.
- Answering machines are not distinguishable without detection. An answered machine may count as connected. Does it say so?
- `expiresAt` retention, and the `MaximumEventAgeInSeconds` of retry schedules.

---

## CCB-156: Reconciliation sweep for stuck callbacks

### Prompt

```markdown
Next ticket. Please implement it, run the tests and typecheck, and summarise your changes.

# CCB-156: Reconciliation sweep for stuck callbacks

**Type:** Feature  **Priority:** Medium  **Component:** new Lambda, template

## Background
Several failure modes leave a callback that will never complete, and today they only show up
as alarms:
- createCallback writes the record and then fails to create the schedule. A flow retry then
  returns the existing record as if it were scheduled.
- dispatch dies after claiming a record, leaving it DISPATCHING.
- A dispatch retry is scheduled but the claim can't be released, leaving it DISPATCHING with a
  schedule that fires into it.
- A dispatched call never produces an outcome event.

## Requirements
- A scheduled Lambda runs every 5 minutes (configurable) and finds callbacks that are:
  - SCHEDULED, and overdue by more than a configurable grace period (default 15 minutes)
  - DISPATCHING past a configurable timeout
  - DISPATCHED, with no outcome after a configurable timeout
- Overdue SCHEDULED callbacks are recovered: dispatched at once if in callback hours,
  otherwise rescheduled for the next opening.
- For stuck DISPATCHING callbacks, where we can't tell whether a call was placed, do whatever
  is safest for the customer. Explain the choice in the README.
- Callbacks with no outcome are moved to a clear terminal state and counted.
- Very old overdue callbacks (configurable, default 24 hours) aren't called. They go FAILED
  with a reason.
- Emit CloudWatch metrics per category, with an alarm on anything recovered or abandoned.
  Replace the stale-claim alarm from CCB-158 if this makes it redundant.
- Must be safe if two sweeps overlap, and if a late dispatch runs during a sweep.
- Must not scan the whole table on each run.

## Acceptance criteria
- Tests cover each category, boundary times, overlapping sweeps, a late dispatch during a
  sweep, a cancel during a sweep, a record waiting for a dispatch retry, an empty result, and
  pagination.
- Query design and expected cost are explained in the README.
- Fix createCallback's retry path so it no longer reports a missing schedule as success, or
  explain in your summary why the sweep is enough.
```

### Follow-ups

1. `A schedule is 16 minutes late because Scheduler retried, and the sweep picks up the same record. Can the customer get two calls? Show me what stops it.`
2. `For a record stuck mid-dispatch, you don't know whether a call happened. What did you choose, what's the worst outcome for the customer, and what would make you choose differently?`
3. `What does this cost per month at 10,000 callbacks a day? Show your assumptions, and tell me which numbers you are unsure of.`
4. `If this sweep has a bug and starts recovering records it shouldn't, how bad could one run get, and what limits it?`

### Watch for

- Does it add a volume cap or kill switch? CCB-160 has one; does it reuse the idea? Follow-up 4 tests whether it notices the risk of an automated mass-calling bug.
- A record waiting for a retry is SCHEDULED with a future retry schedule, but `scheduledFor` is still the original time. A naive "overdue" check will flag every retrying callback. Good bug to catch.
- `status` as a GSI hash key is low cardinality, and sparse indexes have tradeoffs. Does it weigh them? Any index from CCB-160 may already fit.
- Recovering a stuck record risks a double call. `ClientToken` may help or hurt depending on what CCB-155 did.
- Eventually consistent GSI reads: does it rely on the conditional update rather than the query result?
- Scope: the retry-path clause in `createCallback` is optional. Does it choose clearly?
- Cost figures are a good place to spot invented precision.

---

## CCB-157: Per-queue callback hours and regional bank holidays

### Prompt

```markdown
Next ticket. Please implement it, run the tests and typecheck, and summarise your changes.

# CCB-157: Per-queue callback hours and regional bank holidays

**Type:** Feature  **Priority:** Low  **Component:** hours config, callback service, template

## Background
Hours are one global setting per deployment, using the England and Wales bank holiday list.
Our Scotland and Northern Ireland queues need different hours and different bank holidays, and
we can't reasonably run a separate deployment for each.

## Requirements
- Define named hours profiles (for example `england-wales`, `scotland`, `northern-ireland`),
  each with weekly hours, closed dates, time zone and closing buffer.
- Map queue IDs to profiles. Queues with no mapping use the deployment's existing hours, so
  current environments are unchanged with no config changes.
- Configuration is supplied at deploy time, and validated at cold start with errors that name
  the profile or queue at fault. No new runtime dependencies.
- Every place that decides or moves a callback time uses the hours for that callback's queue:
  create, reschedule, dispatch retries, unanswered retries, requeue and the reconciliation
  sweep.
- `scheduledForLocal` is formatted in that profile's time zone.
- Include 2026 and 2027 bank holidays for Scotland and Northern Ireland as built-in lists.

## Acceptance criteria
- Tests cover: a mapped queue, an unmapped queue, a date closed in only one region, an invalid
  profile, a mapping to a profile that doesn't exist, and each place listed above using the
  right profile.
- Environment-variable size limits are considered, and the README explains the config format.
- README tells ops how to add a queue, add a profile, and roll bank holidays forward.
```

### Follow-ups

1. `Where did the Scotland and Northern Ireland dates come from? Could you verify them? Mark each list as verified or from memory.`
2. `Two profiles, one using a time zone other than Europe/London. Does everything still work, including around clock changes? What did you test and what didn't you?`
3. `Which callbacks already in the table are affected when a queue's profile changes after they were booked?`
4. `What's the largest config this supports before it hits the Lambda environment limit? How would we know we'd got close?`

### Watch for

- **Dates:** check them yourself against gov.uk/bank-holidays. Scotland has 2 January and St Andrew's Day, and Northern Ireland has St Patrick's Day and 12 July. Substitute days are easy to get wrong. Mark any wrong date presented confidently.
- **Latent bug at `localTime.ts:105`:** `Math.max` gives wrong times just after spring-forward in zones west of UTC, such as New York. Follow-up 2 opens this door. Does it find it?
- Lookups by queue ID when the only reference is on the record: does it thread the value everywhere, or miss one path? Dispatch retries (CCB-159) and requeue (CCB-160) are the likeliest to be missed.
- Scope creep: a DynamoDB config table or admin API was not requested.
- The hours env vars must reach every function that now needs them, including dispatch, not just create.

---

## End-of-session prompts

Use after the final ticket, for your cross-turn section of the form.

1. `Looking back over these tickets, was anything you told me earlier wrong or out of date now? Be specific.`
2. `What's the riskiest thing still in this codebase? What would you want tested in a real AWS account before this went live?`
3. `Is there anything you changed that wasn't asked for in a ticket? List it.`
