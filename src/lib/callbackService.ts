import { randomUUID } from "node:crypto";
import type { CallbackHours } from "./callbackHours.js";
import { resolveCallbackTime } from "./callbackTime.js";
import { formatForReadback } from "./localTime.js";
import { log, maskPhone } from "./logger.js";
import type { CallbackRepository } from "./repository.js";
import type { CallbackScheduler } from "./scheduler.js";
import type { CallbackRecord, CreateCallbackResult } from "./types.js";
import { normaliseUkPhoneNumber, parsePreferredTime } from "./validation.js";

export interface CreateCallbackInput {
  sourceContactId: string;
  phoneNumber: string;
  queueId: string;
  preferredTime?: string;
}

export interface CallbackServiceDeps {
  repository: CallbackRepository;
  scheduler: CallbackScheduler;
  defaultCallbackDelayMinutes: number;
  /** Preferred times further ahead than this are rejected. */
  maxBookingDaysAhead: number;
  callbackHours: CallbackHours;
  recordRetentionDays: number;
  clock?: () => Date;
  idGenerator?: () => string;
}

export class CallbackService {
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(private readonly deps: CallbackServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.idGenerator = deps.idGenerator ?? randomUUID;
  }

  async createCallback(input: CreateCallbackInput): Promise<CreateCallbackResult> {
    const now = this.clock();

    // Contact flows can retry the Lambda invoke on timeout, so the same inbound
    // contact may ask for a callback twice. Return the existing one.
    const existing = await this.deps.repository.findBySourceContactId(input.sourceContactId);
    if (existing) {
      log("info", "Callback already exists for contact", {
        sourceContactId: input.sourceContactId,
        callbackId: existing.callbackId,
      });
      return {
        callbackId: existing.callbackId,
        scheduledFor: existing.scheduledFor,
        scheduledForLocal: this.toLocal(new Date(existing.scheduledFor)),
        alreadyExisted: true,
      };
    }

    const phoneNumber = normaliseUkPhoneNumber(input.phoneNumber);
    const preferred = parsePreferredTime(input.preferredTime, now);
    const scheduledFor = resolveCallbackTime({
      now,
      preferredTime: preferred,
      defaultDelayMinutes: this.deps.defaultCallbackDelayMinutes,
      maxDaysAhead: this.deps.maxBookingDaysAhead,
      hours: this.deps.callbackHours,
    });

    const callbackId = this.idGenerator();
    const record: CallbackRecord = {
      callbackId,
      sourceContactId: input.sourceContactId,
      phoneNumber,
      queueId: input.queueId,
      scheduledFor: scheduledFor.toISOString(),
      status: "SCHEDULED",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: Math.floor(now.getTime() / 1000) + this.deps.recordRetentionDays * 86_400,
    };

    await this.deps.repository.create(record);
    await this.deps.scheduler.scheduleDispatch(callbackId, scheduledFor);

    log("info", "Callback scheduled", {
      callbackId,
      sourceContactId: input.sourceContactId,
      phone: maskPhone(phoneNumber),
      scheduledFor: record.scheduledFor,
    });

    return {
      callbackId,
      scheduledFor: record.scheduledFor,
      scheduledForLocal: this.toLocal(scheduledFor),
      alreadyExisted: false,
    };
  }

  private toLocal(when: Date): string {
    return formatForReadback(when, this.deps.callbackHours.timeZone);
  }
}
