type Level = "debug" | "info" | "warn" | "error";

/** Minimal structured logger so CloudWatch Logs Insights can query fields. */
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, ...fields, ts: new Date().toISOString() });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Masks all but the last 4 digits so phone numbers don't end up in logs. */
export function maskPhone(phone: string): string {
  return phone.length <= 4 ? "****" : `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}
