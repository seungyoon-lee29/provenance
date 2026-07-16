import { describe, expect, it } from "vitest";

import {
  MAX_PUSH_ENDPOINTS_PER_INSTALL,
  MAX_PUSH_PAYLOAD_BYTES,
  assertPushEndpointBudget,
  assertPushPayloadWithinLimit,
  classifyPushOutcome,
  pushNotificationTag,
  resolvePushTarget,
} from "../src/modules/notification-center/push-transport";

const PUBLIC = async () => ["93.184.216.34"];
const PRIVATE = async () => ["10.0.0.5"];

describe("resolvePushTarget — SSRF guard (spec §12 line 334)", () => {
  it("accepts an exact-host HTTPS endpoint resolving to a public address", async () => {
    const out = await resolvePushTarget("https://updates.push.services.mozilla.com/wpush/v2/abc", PUBLIC);
    expect(out.target).toBe("https://updates.push.services.mozilla.com/wpush/v2/abc");
    expect(out.addresses).toEqual(["93.184.216.34"]);
  });

  it("allows a query string (WNS-style token) but rejects a fragment", async () => {
    await expect(resolvePushTarget("https://x.notify.windows.com/?token=abc", PUBLIC)).resolves.toBeDefined();
    await expect(resolvePushTarget("https://x.notify.windows.com/p#frag", PUBLIC)).rejects.toThrow();
  });

  it("rejects non-HTTPS, an explicit port, credentials, and IP-literal hosts", async () => {
    await expect(resolvePushTarget("http://fcm.googleapis.com/x", PUBLIC)).rejects.toThrow();
    await expect(resolvePushTarget("https://fcm.googleapis.com:8443/x", PUBLIC)).rejects.toThrow();
    await expect(resolvePushTarget("https://user:pw@fcm.googleapis.com/x", PUBLIC)).rejects.toThrow();
    await expect(resolvePushTarget("https://93.184.216.34/x", PUBLIC)).rejects.toThrow();
  });

  it("rejects an endpoint that resolves to a private network (SSRF)", async () => {
    await expect(resolvePushTarget("https://evil.example.com/x", PRIVATE)).rejects.toThrow("forbidden network");
  });
});

describe("push payload and endpoint budgets (spec §12 line 334)", () => {
  it("rejects a payload over 4096 bytes", () => {
    expect(() => assertPushPayloadWithinLimit(new Uint8Array(MAX_PUSH_PAYLOAD_BYTES))).not.toThrow();
    expect(() => assertPushPayloadWithinLimit(new Uint8Array(MAX_PUSH_PAYLOAD_BYTES + 1))).toThrow();
  });
  it("rejects more than 5 endpoints per install", () => {
    expect(() => assertPushEndpointBudget(MAX_PUSH_ENDPOINTS_PER_INSTALL)).not.toThrow();
    expect(() => assertPushEndpointBudget(MAX_PUSH_ENDPOINTS_PER_INSTALL + 1)).toThrow();
  });
});

describe("classifyPushOutcome (spec §12 line 349)", () => {
  it("maps every documented provider response to its typed outcome", () => {
    expect(classifyPushOutcome({ kind: "accepted" })).toEqual({ kind: "accepted" });
    expect(classifyPushOutcome({ kind: "status", code: 201 })).toEqual({ kind: "accepted" });
    expect(classifyPushOutcome({ kind: "accepted_before_timeout" })).toEqual({ kind: "accepted_unconfirmed" });
    expect(classifyPushOutcome({ kind: "status", code: 404 })).toEqual({ kind: "subscription_inactive" });
    expect(classifyPushOutcome({ kind: "status", code: 410 })).toEqual({ kind: "subscription_inactive" });
    expect(classifyPushOutcome({ kind: "status", code: 413 })).toEqual({ kind: "permanent_failure", reason: "payload" });
    expect(classifyPushOutcome({ kind: "status", code: 400 })).toEqual({ kind: "permanent_failure", reason: "config" });
    expect(classifyPushOutcome({ kind: "status", code: 401 })).toEqual({ kind: "circuit_open" });
    expect(classifyPushOutcome({ kind: "status", code: 403 })).toEqual({ kind: "circuit_open" });
    expect(classifyPushOutcome({ kind: "status", code: 429 })).toEqual({ kind: "rate_limited" });
    expect(classifyPushOutcome({ kind: "status", code: 500 })).toEqual({ kind: "retry" });
    expect(classifyPushOutcome({ kind: "status", code: 503 })).toEqual({ kind: "retry" });
    expect(classifyPushOutcome({ kind: "network_error" })).toEqual({ kind: "retry" });
  });
  it("fails closed (no retry) on an unrecognized 4xx", () => {
    expect(classifyPushOutcome({ kind: "status", code: 418 })).toEqual({ kind: "permanent_failure", reason: "config" });
  });
});

describe("pushNotificationTag — accept-before-timeout convergence (spec §12 line 349)", () => {
  it("is stable per delivery cause so retries coalesce to one on-screen notification", () => {
    expect(pushNotificationTag("cause:alert:rule:1")).toBe(pushNotificationTag("cause:alert:rule:1"));
    expect(pushNotificationTag("cause:alert:rule:1")).not.toBe(pushNotificationTag("cause:alert:rule:2"));
  });
});
