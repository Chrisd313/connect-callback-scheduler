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

  static scheduleName(callbackId: string): string {
    return `callback-${callbackId}`;
  }

  async scheduleDispatch(callbackId: string, when: Date): Promise<void> {
    const payload: DispatchEvent = { callbackId };

    await this.client.send(
      new CreateScheduleCommand({
        Name: CallbackScheduler.scheduleName(callbackId),
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
  async cancelDispatch(callbackId: string): Promise<boolean> {
    try {
      await this.client.send(
        new DeleteScheduleCommand({
          Name: CallbackScheduler.scheduleName(callbackId),
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
