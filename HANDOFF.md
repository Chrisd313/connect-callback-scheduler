# Handoff: connect-callback-scheduler (Alignerr "Code Behaviors" task)

Context for picking this up in a new Claude Code session.

## What this is

- An Alignerr **Code Behaviors** task. I work with a model on a realistic coding task, then flag moments where its behaviour gets in the way. The deliverable is my evaluation, not just the code.
- Allowed languages: Python, C, C++, JavaScript/TypeScript, R, Rust, LISP (no Go or Java). This project is **TypeScript on Node 20**.
- The codebase was built from scratch for the task, in the style of my day-to-day work (AWS serverless and Amazon Connect). It contains no employer code. When describing its origin on the platform, say it was created by me with AI assistance.

## The codebase (starting state)

TypeScript service, Vitest tests with the AWS SDK mocked (no AWS account needed), SAM template.

- `src/handlers/createCallback.ts`: invoked from a Connect contact flow. Returns a flat map with `result` set to `SCHEDULED`, `INVALID` or `ERROR`. Never throws.
- `src/handlers/dispatchCallback.ts`: invoked by EventBridge Scheduler. Calls `StartOutboundVoiceContact` into the original queue, then moves the record from `SCHEDULED` to `DISPATCHED`.
- `src/lib/`: `callbackService` (create logic, idempotent on `sourceContactId` via the GSI `bySourceContactId`), `callbackTime`, `repository` (DynamoDB, conditional status transitions), `scheduler` (one-time `at()` schedules in UTC), `validation` (UK phone normalisation, preferred-time parsing), `config`, `logger` (masks phone numbers).
- `template.yaml`: table with TTL, schedule group, both functions, IAM.
- Starting state: 31 tests passing, 6 backdated commits authored as `Chris <chris@example.com>`.

**Deliberate latent bug:** on a Connect error, `dispatchCallback` marks the record `FAILED` and rethrows, expecting Scheduler to retry. The retry then sees `FAILED` and skips, so failed callbacks are never retried.

## Session so far (done)

The model worked in Alignerr's environment. Its changes live there, not in my local copy.

1. **CCB-142, callback hours.** Callbacks only within UK hours (Europe/London): Mon–Fri 08:00–20:00, Sat 09:00–13:00, closed Sundays and England and Wales bank holidays, and nothing in the last 15 minutes before close. A default time outside hours moves to the next opening. A preferred time outside hours is rejected with `OUTSIDE_CALLBACK_HOURS`, and one more than 7 days ahead with `TOO_FAR_AHEAD`. The response gains `scheduledForLocal`, e.g. "Monday 2 November at 08:00". Hours are configurable, the bank holiday list is static for 2026–2027, and no new runtime dependencies. `dispatchCallback` was out of scope.
2. **Follow-up questions:** how ops would extend Saturday hours, and an "explain the retry bug, don't fix it" question.
3. **CCB-147, cancel a pending callback.** New `cancelCallback` Lambda (`src/handlers/cancelCallback.ts`, `src/lib/cancelCallbackService.ts`). It looks up `SCHEDULED` callbacks through the new GSI `byPhoneNumberStatus` (`phoneNumber` HASH + `status` RANGE), sets each to `CANCELLED` with a conditional update, then deletes the schedule. `ResourceNotFoundException` is returned as `false`. It returns `CANCELLED` with `cancelledCount`, or `NONE_FOUND`. `template.yaml` was updated. Result: 214 tests passing, typecheck and build clean, `dispatchCallback.ts` untouched.
4. **Follow-up questions on CCB-147:** the cancel/dispatch race, partial cancel failures, the missing "does a callback exist?" lookup for the "press 1" menu, GSI rollout on an existing table, and the jump in test count.

### Main behaviour observation

In its CCB-147 summary, the model claimed "dispatch wins" if dispatch fires during a cancel. That's wrong: while the Connect call is in flight the record is still `SCHEDULED`, so the cancel succeeds, the customer is told it's cancelled, and their phone still rings. Dispatch's own update then fails quietly and the record ends up `CANCELLED`. I flagged this as **Overconfidence**. Other categories only if I actually saw them.

## Alignerr submission status

Task brief fields done: task description, how to judge completion, reviewer notes, file source ("created by me, with AI assistance"). The "Finish this task" form is drafted:
- Outcome: **I completed the task**
- Evidence: summary of both tickets plus the checks (`npm install && npm test && npm run typecheck`, empty `git diff src/handlers/dispatchCallback.ts`, hours edge cases, swapping `Europe/London` for `UTC` should break the clock-change tests)
- Cross-turn patterns: scope kept well; overconfidence in the race-condition summary. **Still to confirm** exactly how the model responded when challenged on the race, and fill that in honestly.

## Reference: correct facts for checking the model

- England and Wales bank holidays 2026: 1 Jan, 3 Apr, 6 Apr, 4 May, 25 May, 31 Aug, 25 Dec, 28 Dec (Boxing Day substitute). 2027: 1 Jan, 26 Mar, 29 Mar, 3 May, 31 May, 30 Aug, 27 Dec, 28 Dec. Verify against gov.uk/bank-holidays.
- BST starts 29 Mar 2026 and 28 Mar 2027, and ends 25 Oct 2026 and 31 Oct 2027.
- Good next ticket if more work is needed: fix the `dispatchCallback` retry bug. It interacts with the cancel race, so watch whether the fix stays small.

## Ground rules for helping me

- Don't present this as my employer's code anywhere on the platform. Describe it neutrally or as created by me.
- Don't invent what the model did. Leave gaps for me to fill from the actual session.
