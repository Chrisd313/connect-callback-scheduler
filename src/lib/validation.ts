export class ValidationError extends Error {
  /**
   * Optional machine-readable reason for the contact flow to branch on
   * (e.g. OUTSIDE_CALLBACK_HOURS). When absent the flow receives `message`,
   * which is how the pre-existing validation failures are reported.
   */
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

const UK_E164 = /^\+44[1-9]\d{8,9}$/;

/**
 * Normalises a UK phone number to E.164. Connect usually hands us E.164 already,
 * but numbers typed in via DTMF arrive in national format.
 */
export function normaliseUkPhoneNumber(input: string): string {
  const stripped = input.replace(/[\s()-]/g, "");

  let candidate = stripped;
  if (candidate.startsWith("0044")) {
    candidate = "+44" + candidate.slice(4);
  } else if (candidate.startsWith("0")) {
    candidate = "+44" + candidate.slice(1);
  } else if (candidate.startsWith("44")) {
    candidate = "+" + candidate;
  }

  if (!UK_E164.test(candidate)) {
    throw new ValidationError(`Not a valid UK phone number: ${input}`);
  }
  return candidate;
}

/**
 * Parses the optional preferred callback time collected in the contact flow.
 * Expected as an ISO-8601 timestamp with an offset, e.g. 2026-11-02T14:30:00+00:00.
 */
export function parsePreferredTime(raw: string | undefined, now: Date): Date | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`Preferred callback time is not a valid timestamp: ${raw}`);
  }
  if (parsed.getTime() <= now.getTime()) {
    throw new ValidationError("Preferred callback time must be in the future");
  }
  return parsed;
}
