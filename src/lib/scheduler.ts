import {
  ActionAfterCompletion,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
  ResourceNotFoundException,
  SchedulerClient,
} from "@aws-sdk/client-scheduler";
import { toSchedulerAtExpression } from "./callbackTime.js";
import type { DispatchEvent } from "./types.js";

export interface ScheduleTarget {
  dispatchFunctionArn: string;
  schedulerRoleArn: string;
  scheduleGroupName: string;
}

export class CallbackScheduler {
  constructor(
    private readonly target: ScheduleTarget,
    private readonly client: SchedulerClient = new SchedulerClient({}),
  ) {}

  /**
   * Name of the schedule that will fire next for a callback that has made `attempts`
   * Connect attempts so far. The first is `callback-<id>`; retries get their own name
   * because a one-time schedule deletes itself after firing (ActionAfterCompletion) and
   * that deletion can still be pending when the retry is created.
   */
  static scheduleName(callbackId: string, attempts = 0): string {
    return attempts === 0 ? `callback-${callbackId}` : `callback-${callbackId}-retry-${attempts}`;
  }

  /**
   * Creates the one-time schedule that invokes dispatchCallback at `when`. Pass the
   * number of attempts made so far to schedule a retry (see scheduleName).
   */
  async scheduleDispatch(callbackId: string, when: Date, attempts = 0): Promise<void> {
    const payload: DispatchEvent = { callbackId };

    await this.client.send(
      new CreateScheduleCommand({
        Name: CallbackScheduler.scheduleName(callbackId, attempts),
        GroupName: this.target.scheduleGroupName,
        ScheduleExpression: toSchedulerAtExpression(when),
        ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
        ActionAfterCompletion: ActionAfterCompletion.DELETE,
        Target: {
          Arn: this.target.dispatchFunctionArn,
          RoleArn: this.target.schedulerRoleArn,
          Input: JSON.stringify(payload),
          RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 900 },
        },
      }),
    );
  }

  /**
   * Deletes the one-time schedule for a callback. Returns false if it had already gone,
   * which is normal: schedules delete themselves after firing (ActionAfterCompletion).
   */
  async cancelDispatch(callbackId: string, attempts = 0): Promise<boolean> {
    try {
      await this.client.send(
        new DeleteScheduleCommand({
          Name: CallbackScheduler.scheduleName(callbackId, attempts),
          GroupName: this.target.scheduleGroupName,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return false;
      throw err;
    }
  }
}
