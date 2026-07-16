import { describe, expect, it } from "vitest";

import {
  WEBHOOK_INGRESS,
  WebhookRateLimiter,
  checkWebhookIngress,
  webhookDeadlineExceeded,
} from "../src/modules/notification-center/webhook-ingress";
import { verifyWebhookSignature } from "../src/modules/notification-center/webhook-signature";
import {
  ProviderMessageDirectory,
  WebhookInbox,
  WebhookTombstoneRegistry,
} from "../src/modules/notification-center/webhook-inbox";

// Scripted signing material (network-off lane, not a real provider secret).
// The signature below is a known-good literal computed once outside the
// implementation for exactly this (id, timestamp, body, secret) tuple.
const SECRET = "whsec_c2NyaXB0ZWQtdGVzdC1zaWduaW5nLWtleQ==";
const RAW_BODY = '{"type":"email.delivered","data":{"email_id":"pm:msg-1","to":"spoofed-claim@example.com"}}';
const SVIX_ID = "svix:evt-1";
const TIMESTAMP = 1_700_000_000;
const GOOD_SIGNATURE = "v1,bCLG2LvUjJBos6PdzB2YNhZdPJ0NrOscVKHhHthg2Rw=";
const NOW = TIMESTAMP * 1000;

function signedEnvelope(overrides: Partial<Parameters<WebhookInbox["accept"]>[0]> = {}) {
  return {
    provider: "resend",
    environment: "test",
    svixId: SVIX_ID,
    timestampSeconds: TIMESTAMP,
    rawBody: RAW_BODY,
    signatureHeader: GOOD_SIGNATURE,
    ...overrides,
  };
}

function boundInbox() {
  const directory = new ProviderMessageDirectory();
  directory.bind("pm:msg-1", {
    owner: "workspace:w1",
    ownerKind: "workspace",
    recipientFingerprint: "fp:alice",
    templateRevision: "tpl-7",
  });
  const tombstones = new WebhookTombstoneRegistry([{ version: 1, key: "tombstone-key-v1" }], 1);
  return { inbox: new WebhookInbox(directory, tombstones), directory, tombstones };
}

describe("webhook ingress limits — enforced before buffering (spec §12:343)", () => {
  const ok = {
    method: "POST",
    contentType: "application/json",
    headerCount: 12,
    headerBytes: 2_048,
    declaredBodyBytes: 4_096,
  };

  it("admits a conforming POST+JSON request", () => {
    expect(checkWebhookIngress(ok)).toEqual({ allowed: true });
  });

  it("rejects non-POST and non-JSON before any buffering", () => {
    expect(checkWebhookIngress({ ...ok, method: "GET" })).toEqual({ allowed: false, reason: "method_not_allowed" });
    expect(checkWebhookIngress({ ...ok, contentType: "text/plain" })).toEqual({ allowed: false, reason: "unsupported_media_type" });
    expect(checkWebhookIngress({ ...ok, contentType: undefined })).toEqual({ allowed: false, reason: "unsupported_media_type" });
  });

  it("enforces 64 headers / 16 KiB headers / 256 KiB body as hard limits", () => {
    expect(checkWebhookIngress({ ...ok, headerCount: WEBHOOK_INGRESS.maxHeaders })).toEqual({ allowed: true });
    expect(checkWebhookIngress({ ...ok, headerCount: 65 })).toEqual({ allowed: false, reason: "too_many_headers" });
    expect(checkWebhookIngress({ ...ok, headerBytes: 16 * 1024 + 1 })).toEqual({ allowed: false, reason: "headers_too_large" });
    expect(checkWebhookIngress({ ...ok, declaredBodyBytes: 256 * 1024 + 1 })).toEqual({ allowed: false, reason: "body_too_large" });
  });

  it("marks the 2 second deadline as exceeded exactly at the boundary", () => {
    expect(webhookDeadlineExceeded(0, 1_999)).toBe(false);
    expect(webhookDeadlineExceeded(0, 2_000)).toBe(true);
  });

  it("rate limits a single peer at 10 rps / burst 50 without draining the global lane", () => {
    const limiter = new WebhookRateLimiter();
    const first = Array.from({ length: 50 }, () => limiter.admit("peer:a", 0));
    expect(first.every((r) => r === "admitted")).toBe(true);
    expect(limiter.admit("peer:a", 0)).toBe("peer_limited");
    // 100ms refills one peer token (10 rps).
    expect(limiter.admit("peer:a", 100)).toBe("admitted");
    // an unrelated peer is not affected by peer:a's exhaustion.
    expect(limiter.admit("peer:b", 100)).toBe("admitted");
  });

  it("rate limits globally at 50 rps / burst 100 across peers", () => {
    const limiter = new WebhookRateLimiter();
    const results = Array.from({ length: 120 }, (_, i) => limiter.admit(`peer:${i}`, 0));
    expect(results.filter((r) => r === "admitted")).toHaveLength(100);
    expect(results.filter((r) => r === "global_limited")).toHaveLength(20);
  });
});

describe("webhook signature — raw signature/timestamp verified before parse (spec §12:343)", () => {
  const input = { svixId: SVIX_ID, timestampSeconds: TIMESTAMP, rawBody: RAW_BODY, signatureHeader: GOOD_SIGNATURE };

  it("verifies a correctly signed raw body", () => {
    expect(verifyWebhookSignature(input, SECRET, NOW)).toEqual({ verified: true });
  });

  it("rejects a tampered body, id, or timestamp with the same signature", () => {
    expect(verifyWebhookSignature({ ...input, rawBody: RAW_BODY.replace("delivered", "bounced") }, SECRET, NOW)).toEqual({
      verified: false,
      reason: "signature_mismatch",
    });
    expect(verifyWebhookSignature({ ...input, svixId: "svix:evt-2" }, SECRET, NOW)).toEqual({
      verified: false,
      reason: "signature_mismatch",
    });
  });

  it("accepts a rotation header where any v1 candidate matches", () => {
    const rotated = { ...input, signatureHeader: `v1,AAAA ${GOOD_SIGNATURE}` };
    expect(verifyWebhookSignature(rotated, SECRET, NOW)).toEqual({ verified: true });
  });

  it("rejects timestamps outside the 5 minute tolerance in either direction", () => {
    expect(verifyWebhookSignature(input, SECRET, NOW + 301_000)).toEqual({ verified: false, reason: "stale_timestamp" });
    expect(verifyWebhookSignature(input, SECRET, NOW - 301_000)).toEqual({ verified: false, reason: "future_timestamp" });
    // inside tolerance still verifies.
    expect(verifyWebhookSignature(input, SECRET, NOW + 299_000)).toEqual({ verified: true });
  });

  it("rejects missing signature material without throwing", () => {
    expect(verifyWebhookSignature({ ...input, signatureHeader: "" }, SECRET, NOW)).toEqual({
      verified: false,
      reason: "missing_material",
    });
  });
});

describe("webhook inbox — dedupe + server-stored owner binding (spec §12:343)", () => {
  it("accepts a signed webhook and binds the Fact to the server-stored owner, never webhook claims", () => {
    const { inbox } = boundInbox();
    const outcome = inbox.accept(signedEnvelope(), SECRET, NOW, 1);
    expect(outcome).toEqual({
      status: "accepted",
      owner: { owner: "workspace:w1", ownerKind: "workspace", recipientFingerprint: "fp:alice", templateRevision: "tpl-7" },
      factKind: "delivered",
      svixId: SVIX_ID,
      providerMessageId: "pm:msg-1",
    });
  });

  it("rejects an invalid signature without ever parsing the payload", () => {
    const { inbox } = boundInbox();
    // not even valid JSON — a parse before verify would throw or report parse_error.
    const outcome = inbox.accept(
      signedEnvelope({ rawBody: "{not json", signatureHeader: "v1,AAAA" }),
      SECRET,
      NOW,
      1,
    );
    expect(outcome).toEqual({ status: "rejected", reason: "signature_mismatch" });
    expect(inbox.size("workspace:w1")).toBe(0);
  });

  it("dedupes a redelivery on (provider, environment, svix-id)", () => {
    const { inbox } = boundInbox();
    expect(inbox.accept(signedEnvelope(), SECRET, NOW, 1).status).toBe("accepted");
    expect(inbox.accept(signedEnvelope(), SECRET, NOW, 1).status).toBe("duplicate");
    expect(inbox.size("workspace:w1")).toBe(1);
  });

  it("treats the same svix-id in a different environment as a distinct event", () => {
    const { inbox } = boundInbox();
    expect(inbox.accept(signedEnvelope(), SECRET, NOW, 1).status).toBe("accepted");
    expect(inbox.accept(signedEnvelope({ environment: "live" }), SECRET, NOW, 1).status).toBe("accepted");
    expect(inbox.size("workspace:w1")).toBe(2);
  });

  it("stores an event with no server-side binding as unbound instead of trusting the payload", () => {
    const directory = new ProviderMessageDirectory();
    const tombstones = new WebhookTombstoneRegistry([{ version: 1, key: "tombstone-key-v1" }], 1);
    const inbox = new WebhookInbox(directory, tombstones);
    const outcome = inbox.accept(signedEnvelope(), SECRET, NOW, 1);
    expect(outcome).toEqual({ status: "unbound", svixId: SVIX_ID, providerMessageId: "pm:msg-1" });
    // dedupe still applies to unbound events.
    expect(inbox.accept(signedEnvelope(), SECRET, NOW, 1).status).toBe("duplicate");
  });

  it("never promotes provider open/click engagement to a delivery fact", () => {
    const { inbox, directory } = boundInbox();
    directory.bind("pm:msg-2", {
      owner: "workspace:w1",
      ownerKind: "workspace",
      recipientFingerprint: "fp:alice",
      templateRevision: "tpl-7",
    });
    const body = '{"type":"email.opened","data":{"email_id":"pm:msg-2"}}';
    const outcome = inbox.accept(signedEnvelope({ rawBody: body, svixId: "svix:evt-2", signatureHeader: signFor("svix:evt-2", body) }), SECRET, NOW, 1);
    expect(outcome.status).toBe("accepted");
    if (outcome.status === "accepted") expect(outcome.factKind).toBeUndefined();
  });

  it("rejects a payload without a provider message id as malformed", () => {
    const { inbox } = boundInbox();
    const body = '{"type":"email.delivered","data":{}}';
    const outcome = inbox.accept(signedEnvelope({ rawBody: body, svixId: "svix:evt-3", signatureHeader: signFor("svix:evt-3", body) }), SECRET, NOW, 1);
    expect(outcome).toEqual({ status: "rejected", reason: "malformed_event" });
  });

  it("suppresses inbox writes for an erased owner behind the deletion fence", () => {
    const { inbox } = boundInbox();
    inbox.accept(signedEnvelope(), SECRET, NOW, 1);
    expect(inbox.eraseSubject("workspace:w1", 5)).toBe(1);
    const late = inbox.accept(signedEnvelope({ svixId: "svix:evt-late", signatureHeader: signFor("svix:evt-late", RAW_BODY) }), SECRET, NOW, 3);
    expect(late).toEqual({ status: "suppressed", reason: "deletion_fence" });
    expect(inbox.size("workspace:w1")).toBe(0);
  });
});

describe("erasure webhook tombstone — HMAC lookup before raw storage (spec §12:344)", () => {
  it("suppresses a late webhook whose provider id is tombstoned, allowing only a bounded counter", () => {
    const { inbox, tombstones, directory } = boundInbox();
    // administrative erasure: binding removed, provider id tombstoned.
    directory.erase("pm:msg-1");
    tombstones.record("resend", "test", "pm:msg-1", NOW);
    const outcome = inbox.accept(signedEnvelope(), SECRET, NOW, 1);
    expect(outcome).toEqual({ status: "suppressed", reason: "erasure_tombstone" });
    expect(inbox.size("workspace:w1")).toBe(0);
    expect(inbox.size("unbound:resend|test")).toBe(0);
    expect(tombstones.suppressedCount("resend", "test")).toBe(1);
  });

  it("matches tombstones recorded under a previous key after rotation", () => {
    const registry = new WebhookTombstoneRegistry(
      [
        { version: 1, key: "tombstone-key-v1" },
        { version: 2, key: "tombstone-key-v2" },
      ],
      1,
    );
    registry.record("resend", "test", "pm:old", NOW);
    registry.rotateActive(2);
    expect(registry.suppressed("resend", "test", "pm:old", NOW)).toBe(true);
    expect(registry.suppressed("resend", "test", "pm:other", NOW)).toBe(false);
  });

  it("refuses to retire a key while an unexpired tombstone still references it", () => {
    const registry = new WebhookTombstoneRegistry(
      [
        { version: 1, key: "tombstone-key-v1" },
        { version: 2, key: "tombstone-key-v2" },
      ],
      1,
    );
    registry.record("resend", "test", "pm:old", NOW);
    registry.rotateActive(2);
    expect(() => registry.retireKey(1, NOW)).toThrow(/retire/);
    // after the tombstone's TTL the key may retire.
    const after = NOW + registry.tombstoneTtlMs + 1;
    registry.retireKey(1, after);
    expect(registry.suppressed("resend", "test", "pm:new", after)).toBe(false);
  });

  it("fails raw storage closed when a restored tombstone references a key the registry no longer holds", () => {
    const registry = new WebhookTombstoneRegistry(
      [{ version: 2, key: "tombstone-key-v2" }],
      2,
      // backup-restored tombstone hashed under a v1 key this registry does not hold.
      [{ keyVersion: 1, hash: "deadbeef", expiresAtMs: NOW + 1_000_000 }],
    );
    expect(() => registry.suppressed("resend", "test", "pm:any", NOW)).toThrow(/unavailable/);
    const { directory } = boundInbox();
    const inbox = new WebhookInbox(directory, registry);
    expect(() => inbox.accept(signedEnvelope(), SECRET, NOW, 1)).toThrow(/unavailable/);
    expect(inbox.size("workspace:w1")).toBe(0);
  });

  it("an expired tombstone no longer suppresses", () => {
    const registry = new WebhookTombstoneRegistry([{ version: 1, key: "tombstone-key-v1" }], 1);
    registry.record("resend", "test", "pm:msg-1", NOW);
    expect(registry.suppressed("resend", "test", "pm:msg-1", NOW + registry.tombstoneTtlMs + 1)).toBe(false);
  });
});

// Test-side signer for bodies other than the known-good literal above. It is an
// independent implementation of the published svix scheme (id.ts.body, base64
// HMAC-SHA256), not a re-export of the module under test.
import { createHmac } from "node:crypto";
function signFor(svixId: string, rawBody: string): string {
  const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${svixId}.${TIMESTAMP}.${rawBody}`).digest("base64")}`;
}
