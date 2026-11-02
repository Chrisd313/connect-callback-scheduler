import {
  AccessDeniedException,
  DestinationNotAllowedException,
  InternalServiceException,
  InvalidParameterException,
  InvalidRequestException,
  LimitExceededException,
  OutboundContactNotPermittedException,
  ResourceNotFoundException,
  ThrottlingException,
  TooManyRequestsException,
} from "@aws-sdk/client-connect";
import { describe, expect, it } from "vitest";
import { isTransientConnectError } from "../src/lib/connectErrors.js";

const meta = (httpStatusCode: number) => ({ $metadata: { httpStatusCode } });

describe("isTransientConnectError", () => {
  describe("Connect service errors", () => {
    it.each([
      ["ThrottlingException", new ThrottlingException({ message: "Rate exceeded", ...meta(429) })],
      ["TooManyRequestsException", new TooManyRequestsException({ message: "Too many", ...meta(429) })],
      ["LimitExceededException", new LimitExceededException({ message: "Limit", ...meta(429) })],
      ["InternalServiceException", new InternalServiceException({ message: "Internal", ...meta(500) })],
    ])("%s is transient", (_, err) => {
      expect(isTransientConnectError(err)).toBe(true);
    });

    it.each([
      ["InvalidParameterException", new InvalidParameterException({ message: "Bad number", ...meta(400) })],
      ["InvalidRequestException", new InvalidRequestException({ message: "Bad request", ...meta(400) })],
      ["ResourceNotFoundException", new ResourceNotFoundException({ message: "No such queue", ...meta(404) })],
      ["DestinationNotAllowedException", new DestinationNotAllowedException({ message: "Not allowed", ...meta(403) })],
      ["OutboundContactNotPermittedException", new OutboundContactNotPermittedException({ message: "Not permitted", ...meta(403) })],
      ["AccessDeniedException", new AccessDeniedException({ message: "Denied", ...meta(403) })],
    ])("%s is permanent", (_, err) => {
      expect(isTransientConnectError(err)).toBe(false);
    });
  });

  describe("errors we only know by shape", () => {
    it("treats the SDK's retryable flag as transient", () => {
      expect(isTransientConnectError({ name: "SomethingNew", $retryable: { throttling: true } })).toBe(true);
    });

    it("treats server faults as transient and client faults as permanent", () => {
      expect(isTransientConnectError({ name: "SomethingNew", $fault: "server" })).toBe(true);
      expect(isTransientConnectError({ name: "SomethingNew", $fault: "client" })).toBe(false);
    });

    it.each([408, 429, 500, 502, 503, 504])("HTTP %i is transient", (status) => {
      expect(isTransientConnectError({ name: "SomethingNew", ...meta(status) })).toBe(true);
    });

    it.each([400, 403, 404, 409, 422])("HTTP %i is permanent", (status) => {
      expect(isTransientConnectError({ name: "SomethingNew", ...meta(status) })).toBe(false);
    });

    it("a known name wins over a contradictory status", () => {
      // LimitExceededException is modelled as a client fault but clears with time.
      expect(isTransientConnectError(new LimitExceededException({ message: "Limit", ...meta(400) }))).toBe(true);
    });
  });

  describe("no response at all", () => {
    it.each([
      ["SDK timeout", Object.assign(new Error("Request timed out"), { name: "TimeoutError" })],
      ["socket reset", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
      ["plain Error", new Error("boom")],
      ["non-Error value", "boom"],
      ["null", null],
    ])("%s is transient (bounded attempts make the optimistic choice cheap)", (_, err) => {
      expect(isTransientConnectError(err)).toBe(true);
    });
  });
});
