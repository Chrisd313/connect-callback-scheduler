import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/lib/config.js";

const REQUIRED = {
  CALLBACKS_TABLE: "callbacks-test",
  CONNECT_INSTANCE_ID: "instance-1",
  OUTBOUND_CONTACT_FLOW_ID: "flow-1",
  DISPATCH_FUNCTION_ARN: "arn:dispatch",
  SCHEDULER_ROLE_ARN: "arn:role",
};

describe("loadConfig dispatch retry settings", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(REQUIRED)) vi.stubEnv(name, value);
    vi.stubEnv("DISPATCH_MAX_ATTEMPTS", "");
    vi.stubEnv("DISPATCH_RETRY_DELAY_SECONDS", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to 3 attempts 60 seconds apart", () => {
    expect(loadConfig()).toMatchObject({ dispatchMaxAttempts: 3, dispatchRetryDelaySeconds: 60 });
  });

  it("reads the overrides", () => {
    vi.stubEnv("DISPATCH_MAX_ATTEMPTS", "5");
    vi.stubEnv("DISPATCH_RETRY_DELAY_SECONDS", "120");

    expect(loadConfig()).toMatchObject({ dispatchMaxAttempts: 5, dispatchRetryDelaySeconds: 120 });
  });

  it("allows a single attempt, which turns retries off", () => {
    vi.stubEnv("DISPATCH_MAX_ATTEMPTS", "1");

    expect(loadConfig().dispatchMaxAttempts).toBe(1);
  });

  it.each(["0", "-1", "2.5", "three"])("rejects DISPATCH_MAX_ATTEMPTS=%s loudly", (value) => {
    vi.stubEnv("DISPATCH_MAX_ATTEMPTS", value);

    expect(() => loadConfig()).toThrow(/DISPATCH_MAX_ATTEMPTS/);
  });

  it.each(["0", "-30", "1.5"])("rejects DISPATCH_RETRY_DELAY_SECONDS=%s loudly", (value) => {
    vi.stubEnv("DISPATCH_RETRY_DELAY_SECONDS", value);

    expect(() => loadConfig()).toThrow(/DISPATCH_RETRY_DELAY_SECONDS/);
  });
});
