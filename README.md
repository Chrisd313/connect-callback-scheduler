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
                                          (placed into the original queue)
```

1. The contact flow collects (or defaults) the callback number and an optional preferred time, then invokes `createCallback`.
2. `createCallback` validates the number, works out the callback time, stores a `SCHEDULED` record and creates a one-time schedule. It returns a flat map that the flow branches on via `result` (`SCHEDULED`, `INVALID`, `ERROR`).
3. At the scheduled time, Scheduler invokes `dispatchCallback`, which starts the outbound call and moves the record to `DISPATCHED`.

### Contact flow parameters

| Parameter       | Required | Notes                                                                 |
|-----------------|----------|-----------------------------------------------------------------------|
| `callbackNumber`| No       | Defaults to the caller's number (`CustomerEndpoint.Address`).          |
| `queueId`       | No       | Defaults to the queue the contact is currently in.                    |
| `preferredTime` | No       | ISO-8601 with offset. If omitted we call back after the default delay. |

### Idempotency

- Contact flows can retry a Lambda invoke on timeout, so `createCallback` looks up existing records by `sourceContactId` (GSI `bySourceContactId`) and returns the existing callback instead of creating a second one.
- `dispatchCallback` only acts on records in `SCHEDULED`, and passes `callbackId` as the Connect `ClientToken`.

## Project layout

```
src/
  handlers/          Lambda entry points (thin; wire up dependencies)
  lib/
    callbackService  Create-callback business logic
    callbackTime     Works out when to call back; Scheduler expression formatting
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
