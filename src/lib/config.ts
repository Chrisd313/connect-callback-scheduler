import type { CallbackHours } from "./callbackHours.js";
import { callbackHoursFromEnv } from "./callbackHoursConfig.js";

export interface AppConfig {
  tableName: string;
  connectInstanceId: string;
  outboundContactFlowId: string;
  dispatchFunctionArn: string;
  schedulerRoleArn: string;
  scheduleGroupName: string;
  /** Minutes to wait before calling back when the customer doesn't request a specific time. */
  defaultCallbackDelayMinutes: number;
  /** Furthest ahead a customer may book a preferred callback time. */
  maxBookingDaysAhead: number;
  /** When agents are available to take callbacks. See callbackHoursFromEnv for the variables. */
  callbackHours: CallbackHours;
  /** Records are kept for this many days after creation, then DynamoDB TTL removes them. */
  recordRetentionDays: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function numberOr(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  return {
    tableName: required("CALLBACKS_TABLE"),
    connectInstanceId: required("CONNECT_INSTANCE_ID"),
    outboundContactFlowId: required("OUTBOUND_CONTACT_FLOW_ID"),
    dispatchFunctionArn: required("DISPATCH_FUNCTION_ARN"),
    schedulerRoleArn: required("SCHEDULER_ROLE_ARN"),
    scheduleGroupName: process.env.SCHEDULE_GROUP_NAME ?? "connect-callbacks",
    defaultCallbackDelayMinutes: numberOr("DEFAULT_CALLBACK_DELAY_MINUTES", 15),
    maxBookingDaysAhead: numberOr("MAX_BOOKING_DAYS_AHEAD", 7),
    callbackHours: callbackHoursFromEnv(),
    recordRetentionDays: numberOr("RECORD_RETENTION_DAYS", 30),
  };
}
