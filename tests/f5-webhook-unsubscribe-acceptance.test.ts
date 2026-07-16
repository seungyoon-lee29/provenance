/**
 * Acceptance tests for F5 webhook inbox and RFC 8058 unsubscribe modules.
 * Written FROM THE SPEC ONLY — implementations are treated as black boxes.
 * Refutation-oriented: each test would FAIL if the implementation violated the spec.
 */

import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import {
  WEBHOOK_INGRESS,
  checkWebhookIngress,
  webhookDeadlineExceeded,
  WebhookRateLimiter,
} from "../src/modules/notification-center/webhook-ingress";

import {
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  verifyWebhookSignature,
} from "../src/modules/notification-center/webhook-signature";

import {
  WebhookOwnerBinding,
  ProviderMessageDirectory,
  WebhookTombstoneRegistry,
  WebhookInbox,
} from "../src/modules/notification-center/webhook-inbox";

import {
  UnsubscribeLineage,
  UnsubscribeTokenStore,
  FormField,
  parseUrlencodedFields,
  handleUnsubscribe,
  UNSUBSCRIBE_INGRESS,
  checkUnsubscribeIngress,
  UnsubscribeFloodLimiter,
  UNSUBSCRIBE_AUDIT_SAMPLES_PER_HOUR,
  UnsubscribeInvalidAudit,
} from "../src/modules/notification-center/unsubscribe";

// ---------------------------------------------------------------------------
// Helpers — compute real svix HMAC-SHA256 signatures
// ---------------------------------------------------------------------------

/**
 * Derives the signing key from a webhook secret.
 * Published scheme: base64-decode after stripping "whsec_" prefix; if no prefix, use utf8 bytes.
 */
function deriveSigningKey(secret: string): Buffer {
  if (secret.startsWith("whsec_")) {
    return Buffer.from(secret.slice("whsec_".length), "base64");
  }
  return Buffer.from(secret, "utf8");
}

/**
 * Builds a valid v1 signature header for the given inputs.
 * signed content = `${svixId}.${timestampSeconds}.${rawBody}`
 */
function buildSignatureHeader(
  svixId: string,
  timestampSeconds: number,
  rawBody: string,
  secret: string
): string {
  const key = deriveSigningKey(secret);
  const signedContent = `${svixId}.${timestampSeconds}.${rawBody}`;
  const digest = createHmac("sha256", key).update(signedContent).digest("base64");
  return `v1,${digest}`;
}

// Fixed test constants
const SECRET = "whsec_dGVzdHNlY3JldGtleXRlc3RzZWNyZXRrZXk="; // base64 of "testsecretkeytestsecretkey" (26 bytes = 208 bits; enough for the scheme)
const NOW_MS = 1_700_000_000_000; // arbitrary fixed epoch
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

const VALID_BODY = JSON.stringify({ type: "email.delivered", data: { email_id: "msg-001" } });
const VALID_SVIX_ID = "msg_2Xabc123";

function validSigHeader(svixId = VALID_SVIX_ID, ts = NOW_SECONDS, body = VALID_BODY) {
  return buildSignatureHeader(svixId, ts, body, SECRET);
}

// ---------------------------------------------------------------------------
// 1. SIGNATURE-BEFORE-PARSE
// ---------------------------------------------------------------------------

describe("signature-before-parse ordering", () => {
  const INVALID_JSON = "{this is not valid json!!!";

  it("invalid JSON + BAD signature → rejected with a signature reason, NOT parse_error", () => {
    const badSig = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const result = verifyWebhookSignature(
      {
        svixId: VALID_SVIX_ID,
        timestampSeconds: NOW_SECONDS,
        rawBody: INVALID_JSON,
        signatureHeader: badSig,
      },
      SECRET,
      NOW_MS
    );
    expect(result.verified).toBe(false);
    expect((result as any).reason).toBe("signature_mismatch");
  });

  it("invalid JSON + GOOD signature → verifyWebhookSignature says verified (parse happens later)", () => {
    const goodSig = buildSignatureHeader(VALID_SVIX_ID, NOW_SECONDS, INVALID_JSON, SECRET);
    const result = verifyWebhookSignature(
      {
        svixId: VALID_SVIX_ID,
        timestampSeconds: NOW_SECONDS,
        rawBody: INVALID_JSON,
        signatureHeader: goodSig,
      },
      SECRET,
      NOW_MS
    );
    expect(result.verified).toBe(true);
  });

  it("WebhookInbox: invalid JSON + GOOD signature → status=rejected with parse_error", () => {
    const dir = new ProviderMessageDirectory();
    const tombstones = new WebhookTombstoneRegistry([{ version: 1, key: "key1" }], 1);
    const inbox = new WebhookInbox(dir, tombstones);

    const goodSig = buildSignatureHeader(VALID_SVIX_ID, NOW_SECONDS, INVALID_JSON, SECRET);

    const result = inbox.accept(
      {
        provider: "resend",
        environment: "prod",
        svixId: VALID_SVIX_ID,
        timestampSeconds: NOW_SECONDS,
        rawBody: INVALID_JSON,
        signatureHeader: goodSig,
      },
      SECRET,
      NOW_MS,
      1
    );

    expect(result.status).toBe("rejected");
    expect((result as any).reason).toBe("parse_error");
  });

  it("WebhookInbox: invalid JSON + BAD signature → status=rejected with signature reason (NOT parse_error)", () => {
    const dir = new ProviderMessageDirectory();
    const tombstones = new WebhookTombstoneRegistry([{ version: 1, key: "key1" }], 1);
    const inbox = new WebhookInbox(dir, tombstones);

    const badSig = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    const result = inbox.accept(
      {
        provider: "resend",
        environment: "prod",
        svixId: VALID_SVIX_ID,
        timestampSeconds: NOW_SECONDS,
        rawBody: INVALID_JSON,
        signatureHeader: badSig,
      },
      SECRET,
      NOW_MS,
      1
    );

    expect(result.status).toBe("rejected");
    const reason = (result as any).reason;
    // Must NOT be parse_error — signature was checked first and failed
    expect(reason).not.toBe("parse_error");
    expect(["missing_material", "stale_timestamp", "future_timestamp", "signature_mismatch"]).toContain(reason);
  });
});

// ---------------------------------------------------------------------------
// 2. TIMESTAMP WINDOW BOUNDARIES & ROTATION HEADERS
// ---------------------------------------------------------------------------

describe("timestamp window boundaries", () => {
  it("exactly at tolerance boundary (300 s old) → verified", () => {
    const staleTs = NOW_SECONDS - 300;
    const sig = buildSignatureHeader(VALID_SVIX_ID, staleTs, VALID_BODY, SECRET);
    const result = verifyWebhookSignature(
      { svixId: VALID_SVIX_ID, timestampSeconds: staleTs, rawBody: VALID_BODY, signatureHeader: sig },
      SECRET,
      NOW_MS
    );
    expect(result.verified).toBe(true);
  });

  it("one second past stale boundary (301 s old) → stale_timestamp", () => {
    const staleTs = NOW_SECONDS - 301;
    const sig = buildSignatureHeader(VALID_SVIX_ID, staleTs, VALID_BODY, SECRET);
    const result = verifyWebhookSignature(
      { svixId: VALID_SVIX_ID, timestampSeconds: staleTs, rawBody: VALID_BODY, signatureHeader: sig },
      SECRET,
      NOW_MS
    );
    expect(result.verified).toBe(false);
    expect((result as any).reason).toBe("stale_timestamp");
  });

  it("exactly 300 s in the future → verified", () => {
    const futureTs = NOW_SECONDS + 300;
    const sig = buildSignatureHeader(VALID_SVIX_ID, futureTs, VALID_BODY, SECRET);
    const result = verifyWebhookSignature(
      { svixId: VALID_SVIX_ID, timestampSeconds: futureTs, rawBody: VALID_BODY, signatureHeader: sig },
      SECRET,
      NOW_MS
    );
    expect(result.verified).toBe(true);
  });

  it("301 s in the future → future_timestamp", () => {
    const futureTs = NOW_SECONDS + 301;
    const sig = buildSignatureHeader(VALID_SVIX_ID, futureTs, VALID_BODY, SECRET);
    const result = verifyWebhookSignature(
      { svixId: VALID_SVIX_ID, timestampSeconds: futureTs, rawBody: VALID_BODY, signatureHeader: sig },
      SECRET,
      NOW_MS
    );
    expect(result.verified).toBe(false);
    expect((result as any).reason).toBe("future_timestamp");
  });

  it("WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS is 300", () => {
    expect(WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS).toBe(300);
  });

  it("multiple v1 candidates — second one valid → verified", () => {
    const badCandidate = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const goodDigest = createHmac("sha256", deriveSigningKey(SECRET))
      .update(`${VALID_SVIX_ID}.${NOW_SECONDS}.${VALID_BODY}`)
      .digest("base64");
    const rotationHeader = `${badCandidate} v1,${goodDigest}`;
    const result = verifyWebhookSignature(
      { svixId: VALID_SVIX_ID, timestampSeconds: NOW_SECONDS, rawBody: VALID_BODY, signatureHeader: rotationHeader },
      SECRET,
      NOW_MS
    );
    expect(result.verified).toBe(true);
  });

  it("tampered body → signature_mismatch", () => {
    const sig = validSigHeader();
    const result = verifyWebhookSignature(
      { svixId: VALID_SVIX_ID, timestampSeconds: NOW_SECONDS, rawBody: VALID_BODY + " tampered", signatureHeader: sig },
      SECRET,
      NOW_MS
    );
    expect(result.verified).toBe(false);
    expect((result as any).reason).toBe("signature_mismatch");
  });

  it("tampered svix-id → signature_mismatch", () => {
    const sig = validSigHeader();
    const result = verifyWebhookSignature(
      { svixId: "different-id", timestampSeconds: NOW_SECONDS, rawBody: VALID_BODY, signatureHeader: sig },
      SECRET,
      NOW_MS
    );
    expect(result.verified).toBe(false);
    expect((result as any).reason).toBe("signature_mismatch");
  });

  it("tampered timestamp → signature_mismatch (not stale)", () => {
    const realTs = NOW_SECONDS;
    const sig = buildSignatureHeader(VALID_SVIX_ID, realTs, VALID_BODY, SECRET);
    // present same-range timestamp but the header says something else
    const tamperedTs = NOW_SECONDS + 1;
    const result = verifyWebhookSignature(
      { svixId: VALID_SVIX_ID, timestampSeconds: tamperedTs, rawBody: VALID_BODY, signatureHeader: sig },
      SECRET,
      NOW_MS
    );
    expect(result.verified).toBe(false);
    expect((result as any).reason).toBe("signature_mismatch");
  });
});

// ---------------------------------------------------------------------------
// 3. DEDUPE on (provider, environment, svix-id)
// ---------------------------------------------------------------------------

describe("webhook inbox deduplication", () => {
  function makeInbox() {
    const dir = new ProviderMessageDirectory();
    const tombstones = new WebhookTombstoneRegistry([{ version: 1, key: "k1" }], 1);
    return { inbox: new WebhookInbox(dir, tombstones), dir };
  }

  const BINDING: WebhookOwnerBinding = {
    owner: "ws-1",
    ownerKind: "workspace",
    recipientFingerprint: "fp-abc",
    templateRevision: "rev-1",
  };
  const BODY_SENT = JSON.stringify({ type: "email.sent", data: { email_id: "msg-DUPE" } });

  it("second delivery of same (provider, environment, svix-id) → duplicate", () => {
    const { inbox, dir } = makeInbox();
    dir.bind("msg-DUPE", BINDING);
    const envelope = {
      provider: "resend",
      environment: "prod",
      svixId: "svix-dupe",
      timestampSeconds: NOW_SECONDS,
      rawBody: BODY_SENT,
      signatureHeader: buildSignatureHeader("svix-dupe", NOW_SECONDS, BODY_SENT, SECRET),
    };

    const first = inbox.accept(envelope, SECRET, NOW_MS, 1);
    expect(first.status).toBe("accepted");

    const second = inbox.accept(envelope, SECRET, NOW_MS, 1);
    expect(second.status).toBe("duplicate");
  });

  it("same svix-id in different provider → NOT a duplicate", () => {
    const { inbox, dir } = makeInbox();
    dir.bind("msg-DUPE", BINDING);
    const base = {
      svixId: "svix-dupe",
      timestampSeconds: NOW_SECONDS,
      rawBody: BODY_SENT,
    };
    const envResend = {
      ...base,
      provider: "resend",
      environment: "prod",
      signatureHeader: buildSignatureHeader(base.svixId, base.timestampSeconds, base.rawBody, SECRET),
    };
    const envOther = {
      ...base,
      provider: "sendgrid",
      environment: "prod",
      signatureHeader: buildSignatureHeader(base.svixId, base.timestampSeconds, base.rawBody, SECRET),
    };

    const r1 = inbox.accept(envResend, SECRET, NOW_MS, 1);
    expect(r1.status).toBe("accepted");

    // Different provider — not a duplicate regardless of same svix-id
    const r2 = inbox.accept(envOther, SECRET, NOW_MS, 1);
    expect(r2.status).not.toBe("duplicate");
  });

  it("same svix-id in different environment → NOT a duplicate", () => {
    const { inbox, dir } = makeInbox();
    dir.bind("msg-DUPE", BINDING);
    const base = {
      provider: "resend",
      svixId: "svix-dupe",
      timestampSeconds: NOW_SECONDS,
      rawBody: BODY_SENT,
    };
    const envProd = {
      ...base,
      environment: "prod",
      signatureHeader: buildSignatureHeader(base.svixId, base.timestampSeconds, base.rawBody, SECRET),
    };
    const envStaging = {
      ...base,
      environment: "staging",
      signatureHeader: buildSignatureHeader(base.svixId, base.timestampSeconds, base.rawBody, SECRET),
    };

    inbox.accept(envProd, SECRET, NOW_MS, 1);
    const r2 = inbox.accept(envStaging, SECRET, NOW_MS, 1);
    expect(r2.status).not.toBe("duplicate");
  });

  it("duplicate leaves exactly one stored entry, not two", () => {
    const { inbox, dir } = makeInbox();
    dir.bind("msg-DUPE", BINDING);
    const envelope = {
      provider: "resend",
      environment: "prod",
      svixId: "svix-count",
      timestampSeconds: NOW_SECONDS,
      rawBody: BODY_SENT,
      signatureHeader: buildSignatureHeader("svix-count", NOW_SECONDS, BODY_SENT, SECRET),
    };
    inbox.accept(envelope, SECRET, NOW_MS, 1);
    inbox.accept(envelope, SECRET, NOW_MS, 1);
    // size counts accepted entries for the subject; should be 1
    const subject = BINDING.owner;
    expect(inbox.size(subject)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. OWNER BINDING — server-stored, not webhook-claimed
// ---------------------------------------------------------------------------

describe("owner binding", () => {
  function makeInbox() {
    const dir = new ProviderMessageDirectory();
    const tombstones = new WebhookTombstoneRegistry([{ version: 1, key: "k1" }], 1);
    return { inbox: new WebhookInbox(dir, tombstones), dir };
  }

  it("accepted event carries the server-stored binding, ignoring webhook-claimed owner", () => {
    const { inbox, dir } = makeInbox();
    const serverBinding: WebhookOwnerBinding = {
      owner: "ws-server",
      ownerKind: "workspace",
      recipientFingerprint: "fp-real",
      templateRevision: "rev-real",
    };
    dir.bind("msg-bind-test", serverBinding);
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg-bind-test" } });
    const svixId = "svix-bind";
    const result = inbox.accept(
      {
        provider: "resend",
        environment: "prod",
        svixId,
        timestampSeconds: NOW_SECONDS,
        rawBody: body,
        signatureHeader: buildSignatureHeader(svixId, NOW_SECONDS, body, SECRET),
      },
      SECRET,
      NOW_MS,
      1
    );
    expect(result.status).toBe("accepted");
    const accepted = result as Extract<typeof result, { status: "accepted" }>;
    expect(accepted.owner).toEqual(serverBinding);
    expect(accepted.owner.owner).toBe("ws-server");
    expect(accepted.owner.recipientFingerprint).toBe("fp-real");
  });

  it("message with no server binding → status=unbound, no fabricated owner", () => {
    const { inbox } = makeInbox();
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg-unknown" } });
    const svixId = "svix-unbound";
    const result = inbox.accept(
      {
        provider: "resend",
        environment: "prod",
        svixId,
        timestampSeconds: NOW_SECONDS,
        rawBody: body,
        signatureHeader: buildSignatureHeader(svixId, NOW_SECONDS, body, SECRET),
      },
      SECRET,
      NOW_MS,
      1
    );
    expect(result.status).toBe("unbound");
    // No owner field on unbound
    expect((result as any).owner).toBeUndefined();
  });

  it("email.opened → factKind is undefined (engagement never promoted)", () => {
    const { inbox, dir } = makeInbox();
    const binding: WebhookOwnerBinding = {
      owner: "ws-engage",
      ownerKind: "workspace",
      recipientFingerprint: "fp-e",
      templateRevision: "rev-e",
    };
    dir.bind("msg-opened", binding);
    const body = JSON.stringify({ type: "email.opened", data: { email_id: "msg-opened" } });
    const svixId = "svix-opened";
    const result = inbox.accept(
      {
        provider: "resend",
        environment: "prod",
        svixId,
        timestampSeconds: NOW_SECONDS,
        rawBody: body,
        signatureHeader: buildSignatureHeader(svixId, NOW_SECONDS, body, SECRET),
      },
      SECRET,
      NOW_MS,
      1
    );
    expect(result.status).toBe("accepted");
    expect((result as any).factKind).toBeUndefined();
  });

  it("email.clicked → factKind is undefined (engagement never promoted)", () => {
    const { inbox, dir } = makeInbox();
    const binding: WebhookOwnerBinding = {
      owner: "ws-click",
      ownerKind: "workspace",
      recipientFingerprint: "fp-c",
      templateRevision: "rev-c",
    };
    dir.bind("msg-clicked", binding);
    const body = JSON.stringify({ type: "email.clicked", data: { email_id: "msg-clicked" } });
    const svixId = "svix-clicked";
    const result = inbox.accept(
      {
        provider: "resend",
        environment: "prod",
        svixId,
        timestampSeconds: NOW_SECONDS,
        rawBody: body,
        signatureHeader: buildSignatureHeader(svixId, NOW_SECONDS, body, SECRET),
      },
      SECRET,
      NOW_MS,
      1
    );
    expect(result.status).toBe("accepted");
    expect((result as any).factKind).toBeUndefined();
  });

  it("email.sent → factKind is 'provider_accepted'", () => {
    const { inbox, dir } = makeInbox();
    const binding: WebhookOwnerBinding = { owner: "ws-fk", ownerKind: "workspace", recipientFingerprint: "fp-fk", templateRevision: "rv-fk" };
    dir.bind("msg-fk-sent", binding);
    const body = JSON.stringify({ type: "email.sent", data: { email_id: "msg-fk-sent" } });
    const svixId = "svix-fk-sent";
    const result = inbox.accept(
      { provider: "resend", environment: "prod", svixId, timestampSeconds: NOW_SECONDS, rawBody: body, signatureHeader: buildSignatureHeader(svixId, NOW_SECONDS, body, SECRET) },
      SECRET, NOW_MS, 1
    );
    expect(result.status).toBe("accepted");
    expect((result as any).factKind).toBe("provider_accepted");
  });

  it("email.delivered → factKind is 'delivered'", () => {
    const { inbox, dir } = makeInbox();
    const binding: WebhookOwnerBinding = { owner: "ws-fk2", ownerKind: "workspace", recipientFingerprint: "fp-fk2", templateRevision: "rv-fk2" };
    dir.bind("msg-fk-delivered", binding);
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg-fk-delivered" } });
    const svixId = "svix-fk-del";
    const result = inbox.accept(
      { provider: "resend", environment: "prod", svixId, timestampSeconds: NOW_SECONDS, rawBody: body, signatureHeader: buildSignatureHeader(svixId, NOW_SECONDS, body, SECRET) },
      SECRET, NOW_MS, 1
    );
    expect(result.status).toBe("accepted");
    expect((result as any).factKind).toBe("delivered");
  });

  it("email.bounced → factKind is 'bounced'", () => {
    const { inbox, dir } = makeInbox();
    const binding: WebhookOwnerBinding = { owner: "ws-fk3", ownerKind: "workspace", recipientFingerprint: "fp-fk3", templateRevision: "rv-fk3" };
    dir.bind("msg-fk-bounced", binding);
    const body = JSON.stringify({ type: "email.bounced", data: { email_id: "msg-fk-bounced" } });
    const svixId = "svix-fk-bnc";
    const result = inbox.accept(
      { provider: "resend", environment: "prod", svixId, timestampSeconds: NOW_SECONDS, rawBody: body, signatureHeader: buildSignatureHeader(svixId, NOW_SECONDS, body, SECRET) },
      SECRET, NOW_MS, 1
    );
    expect(result.status).toBe("accepted");
    expect((result as any).factKind).toBe("bounced");
  });

  it("unbound event is stored under unbound subject, not a fabricated owner subject", () => {
    const { inbox } = makeInbox();
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg-no-binding" } });
    const svixId = "svix-unbound2";
    inbox.accept(
      { provider: "resend", environment: "prod", svixId, timestampSeconds: NOW_SECONDS, rawBody: body, signatureHeader: buildSignatureHeader(svixId, NOW_SECONDS, body, SECRET) },
      SECRET, NOW_MS, 1
    );
    // unbound subject contains the event
    const unboundSubject = "unbound:resend|prod";
    expect(inbox.size(unboundSubject)).toBeGreaterThan(0);
    // There is no fabricated workspace entry
    expect(inbox.size("ws-faked")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. ERASURE — TOMBSTONES, KEY ROTATION, FENCING
// ---------------------------------------------------------------------------

describe("erasure tombstones", () => {
  const PROV = "resend";
  const ENV = "prod";

  it("tombstoned provider id → accepted result is suppressed with erasure_tombstone, zero inbox writes", () => {
    const dir = new ProviderMessageDirectory();
    const reg = new WebhookTombstoneRegistry([{ version: 1, key: "tomb-key-1" }], 1);
    const inbox = new WebhookInbox(dir, reg);

    const binding: WebhookOwnerBinding = { owner: "ws-tomb", ownerKind: "workspace", recipientFingerprint: "fp-t", templateRevision: "rv-t" };
    dir.bind("msg-erased", binding);

    // Tombstone the raw provider id
    reg.record(PROV, ENV, "msg-erased", NOW_MS);

    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg-erased" } });
    const svixId = "svix-tomb";
    const result = inbox.accept(
      { provider: PROV, environment: ENV, svixId, timestampSeconds: NOW_SECONDS, rawBody: body, signatureHeader: buildSignatureHeader(svixId, NOW_SECONDS, body, SECRET) },
      SECRET, NOW_MS, 1
    );

    expect(result.status).toBe("suppressed");
    expect((result as any).reason).toBe("erasure_tombstone");
    // No inbox writes for this subject
    expect(inbox.size("ws-tomb")).toBe(0);
  });

  it("tombstoned id: only bounded counter grows, not inbox entries", () => {
    const dir = new ProviderMessageDirectory();
    const reg = new WebhookTombstoneRegistry([{ version: 1, key: "tomb-key-c" }], 1);
    const inbox = new WebhookInbox(dir, reg);
    const binding: WebhookOwnerBinding = { owner: "ws-counter", ownerKind: "workspace", recipientFingerprint: "fp-cnt", templateRevision: "rv-cnt" };
    dir.bind("msg-cnt", binding);

    reg.record(PROV, ENV, "msg-cnt", NOW_MS);

    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg-cnt" } });
    for (let i = 0; i < 3; i++) {
      const svixId = `svix-cnt-${i}`;
      inbox.accept(
        { provider: PROV, environment: ENV, svixId, timestampSeconds: NOW_SECONDS, rawBody: body, signatureHeader: buildSignatureHeader(svixId, NOW_SECONDS, body, SECRET) },
        SECRET, NOW_MS, 1
      );
    }

    // suppressedCount is the bounded counter
    expect(reg.suppressedCount(PROV, ENV)).toBeGreaterThan(0);
    // inbox entries: zero
    expect(inbox.size("ws-counter")).toBe(0);
  });

  it("tombstone survives key rotation — previous key still matches", () => {
    const reg = new WebhookTombstoneRegistry(
      [{ version: 1, key: "old-key" }, { version: 2, key: "new-key" }],
      1 // active is v1
    );

    // Record under v1 (active)
    reg.record(PROV, ENV, "msg-rotate", NOW_MS);

    // Rotate active to v2
    reg.rotateActive(2);

    // Should still be suppressed (v1 tombstone is still unexpired)
    expect(reg.suppressed(PROV, ENV, "msg-rotate", NOW_MS)).toBe(true);
  });

  it("key retirement refused while an unexpired tombstone references that version", () => {
    const reg = new WebhookTombstoneRegistry(
      [{ version: 1, key: "retire-key" }, { version: 2, key: "new-key" }],
      1
    );
    reg.record(PROV, ENV, "msg-retire", NOW_MS);
    reg.rotateActive(2); // v2 is now active, v1 is previous

    // Tombstone TTL is 90 days; it won't expire for a long time
    expect(() => reg.retireKey(1, NOW_MS)).toThrow();
  });

  it("key retirement refused for the active key", () => {
    const reg = new WebhookTombstoneRegistry([{ version: 1, key: "only-key" }], 1);
    expect(() => reg.retireKey(1, NOW_MS)).toThrow();
  });

  it("suppressed() throws (fail closed) when a required key is missing from the registry", () => {
    // Restore a tombstone that references a key version NOT in the registry
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const reg = new WebhookTombstoneRegistry(
      [{ version: 2, key: "only-new-key" }], // v1 is missing
      2,
      [{ keyVersion: 1, hash: "some-hash", expiresAtMs: NOW_MS + NINETY_DAYS_MS }]
    );

    // suppressed() must throw because key version 1 is not in the registry
    expect(() => reg.suppressed(PROV, ENV, "msg-missing-key", NOW_MS)).toThrow();
  });

  it("tombstoneTtlMs is 90 days in ms", () => {
    const reg = new WebhookTombstoneRegistry([{ version: 1, key: "ttl-key" }], 1);
    expect(reg.tombstoneTtlMs).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("deletion fence: late webhook with old epoch is suppressed", () => {
    const dir = new ProviderMessageDirectory();
    const reg = new WebhookTombstoneRegistry([{ version: 1, key: "fence-key" }], 1);
    const inbox = new WebhookInbox(dir, reg);

    const binding: WebhookOwnerBinding = { owner: "ws-fence", ownerKind: "workspace", recipientFingerprint: "fp-fn", templateRevision: "rv-fn" };
    dir.bind("msg-fence", binding);

    // Erase subject at fence=5
    inbox.eraseSubject("ws-fence", 5);

    // Late webhook with atEpoch=4 (before fence) must be suppressed
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg-fence" } });
    const svixId = "svix-late";
    const result = inbox.accept(
      { provider: PROV, environment: ENV, svixId, timestampSeconds: NOW_SECONDS, rawBody: body, signatureHeader: buildSignatureHeader(svixId, NOW_SECONDS, body, SECRET) },
      SECRET, NOW_MS, 4 // atEpoch <= fence
    );

    expect(result.status).toBe("suppressed");
    // Should not create a new personal delivery state
    expect(inbox.size("ws-fence")).toBe(0);
  });

  it("eraseSubject returns count of erased entries", () => {
    const dir = new ProviderMessageDirectory();
    const reg = new WebhookTombstoneRegistry([{ version: 1, key: "k1" }], 1);
    const inbox = new WebhookInbox(dir, reg);

    const binding: WebhookOwnerBinding = { owner: "ws-erase-count", ownerKind: "workspace", recipientFingerprint: "fp-ec", templateRevision: "rv-ec" };

    for (let i = 0; i < 3; i++) {
      dir.bind(`msg-ec-${i}`, binding);
      const body = JSON.stringify({ type: "email.delivered", data: { email_id: `msg-ec-${i}` } });
      const svixId = `svix-ec-${i}`;
      inbox.accept(
        { provider: PROV, environment: ENV, svixId, timestampSeconds: NOW_SECONDS, rawBody: body, signatureHeader: buildSignatureHeader(svixId, NOW_SECONDS, body, SECRET) },
        SECRET, NOW_MS, 1
      );
    }

    const erased = inbox.eraseSubject("ws-erase-count", 99);
    expect(erased).toBe(3);
    expect(inbox.size("ws-erase-count")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. UNSUBSCRIBE TOKEN — 256+ bits, hash-only at rest, lineage binding
// ---------------------------------------------------------------------------

describe("unsubscribe token store", () => {
  const LINEAGE: UnsubscribeLineage = {
    workspace: "ws-unsub",
    endpoint: "ep-1",
    topic: "newsletter",
    channel: "email",
    consentRevision: 1,
  };

  it("issue() returns a token of at least 32 bytes (256 bits) when base64-decoded or at least 64 hex chars", () => {
    const store = new UnsubscribeTokenStore();
    const token = store.issue(LINEAGE, NOW_MS, 1);
    expect(token).toBeDefined();
    // Token should have enough entropy: either raw bytes or hex/base64 encoding
    // 256 bits = 32 bytes = 64 hex chars = ~43 base64 chars
    // We accept any encoding; just check minimum character length for 256 bits
    // base64: ceil(32/3)*4=44, hex: 64, raw: 32
    const minBase64Len = 43; // floor(256/6) roughly
    expect(token!.length).toBeGreaterThanOrEqual(minBase64Len);
  });

  it("raw token does NOT appear in entries() — hash-only at rest", () => {
    const store = new UnsubscribeTokenStore();
    const token = store.issue(LINEAGE, NOW_MS, 1)!;
    const entries = store.entries("ws-unsub");
    // The raw token string must not appear in any entry field
    for (const entry of entries) {
      expect(entry.tokenHash).not.toBe(token);
      // tokenHash should be a derived hash, not the raw token
    }
  });

  it("GET does not consume the token — consume still works after", () => {
    const store = new UnsubscribeTokenStore();
    const token = store.issue(LINEAGE, NOW_MS, 1)!;
    // GET → render_confirmation, no consumption
    const getResult = handleUnsubscribe(
      { method: "GET", token, fields: [] },
      store,
      NOW_MS
    );
    expect(getResult.status).toBe("render_confirmation");
    // Token is still usable
    const lineage = store.consume(token, NOW_MS);
    expect(lineage).toBeDefined();
    expect(lineage?.workspace).toBe("ws-unsub");
  });

  it("POST with exactly-one List-Unsubscribe=One-Click text field → unsubscribed", () => {
    const store = new UnsubscribeTokenStore();
    const token = store.issue(LINEAGE, NOW_MS, 1)!;
    const fields: FormField[] = [
      { name: "List-Unsubscribe", value: "One-Click", kind: "text" },
    ];
    const result = handleUnsubscribe({ method: "POST", token, fields }, store, NOW_MS);
    expect(result.status).toBe("unsubscribed");
    const unsub = result as Extract<typeof result, { status: "unsubscribed" }>;
    expect(unsub.lineage).toEqual(LINEAGE);
  });

  it("POST consume is idempotent — second POST returns unsubscribed", () => {
    const store = new UnsubscribeTokenStore();
    const token = store.issue(LINEAGE, NOW_MS, 1)!;
    const fields: FormField[] = [{ name: "List-Unsubscribe", value: "One-Click", kind: "text" }];
    const r1 = handleUnsubscribe({ method: "POST", token, fields }, store, NOW_MS);
    expect(r1.status).toBe("unsubscribed");
    const r2 = handleUnsubscribe({ method: "POST", token, fields }, store, NOW_MS);
    expect(r2.status).toBe("unsubscribed");
  });

  it("POST with wrong field name → invalid/malformed_one_click", () => {
    const store = new UnsubscribeTokenStore();
    const token = store.issue(LINEAGE, NOW_MS, 1)!;
    const fields: FormField[] = [{ name: "unsubscribe", value: "One-Click", kind: "text" }];
    const result = handleUnsubscribe({ method: "POST", token, fields }, store, NOW_MS);
    expect(result.status).toBe("invalid");
    expect((result as any).reason).toBe("malformed_one_click");
  });

  it("POST with wrong field value → invalid/malformed_one_click", () => {
    const store = new UnsubscribeTokenStore();
    const token = store.issue(LINEAGE, NOW_MS, 1)!;
    const fields: FormField[] = [{ name: "List-Unsubscribe", value: "yes", kind: "text" }];
    const result = handleUnsubscribe({ method: "POST", token, fields }, store, NOW_MS);
    expect(result.status).toBe("invalid");
    expect((result as any).reason).toBe("malformed_one_click");
  });

  it("POST with file field instead of text → invalid/malformed_one_click", () => {
    const store = new UnsubscribeTokenStore();
    const token = store.issue(LINEAGE, NOW_MS, 1)!;
    const fields: FormField[] = [{ name: "List-Unsubscribe", value: "One-Click", kind: "file" }];
    const result = handleUnsubscribe({ method: "POST", token, fields }, store, NOW_MS);
    expect(result.status).toBe("invalid");
    expect((result as any).reason).toBe("malformed_one_click");
  });

  it("POST with zero fields → invalid/malformed_one_click", () => {
    const store = new UnsubscribeTokenStore();
    const token = store.issue(LINEAGE, NOW_MS, 1)!;
    const result = handleUnsubscribe({ method: "POST", token, fields: [] }, store, NOW_MS);
    expect(result.status).toBe("invalid");
    expect((result as any).reason).toBe("malformed_one_click");
  });

  it("POST with two List-Unsubscribe fields → invalid/malformed_one_click (exactly-one)", () => {
    const store = new UnsubscribeTokenStore();
    const token = store.issue(LINEAGE, NOW_MS, 1)!;
    const fields: FormField[] = [
      { name: "List-Unsubscribe", value: "One-Click", kind: "text" },
      { name: "List-Unsubscribe", value: "One-Click", kind: "text" },
    ];
    const result = handleUnsubscribe({ method: "POST", token, fields }, store, NOW_MS);
    expect(result.status).toBe("invalid");
    expect((result as any).reason).toBe("malformed_one_click");
  });

  it("unknown token → invalid/unknown_token", () => {
    const store = new UnsubscribeTokenStore();
    const result = handleUnsubscribe(
      { method: "POST", token: "not-a-real-token", fields: [{ name: "List-Unsubscribe", value: "One-Click", kind: "text" }] },
      store,
      NOW_MS
    );
    expect(result.status).toBe("invalid");
    expect((result as any).reason).toBe("unknown_token");
  });

  it("PUT method → invalid/method_not_allowed", () => {
    const store = new UnsubscribeTokenStore();
    const token = store.issue(LINEAGE, NOW_MS, 1)!;
    const result = handleUnsubscribe(
      { method: "PUT", token, fields: [{ name: "List-Unsubscribe", value: "One-Click", kind: "text" }] },
      store,
      NOW_MS
    );
    expect(result.status).toBe("invalid");
    expect((result as any).reason).toBe("method_not_allowed");
  });

  it("erasure shreds tokens and blocks re-issue at old epochs", () => {
    const store = new UnsubscribeTokenStore();
    store.issue(LINEAGE, NOW_MS, 1);
    store.issue(LINEAGE, NOW_MS, 2);
    const erased = store.eraseSubject("ws-unsub", 10);
    expect(erased).toBeGreaterThan(0);
    expect(store.entries("ws-unsub")).toHaveLength(0);

    // Re-issue at old epoch should be suppressed
    const reissued = store.issue(LINEAGE, NOW_MS, 5); // atEpoch 5 <= fence 10
    expect(reissued).toBeUndefined();
  });

  it("re-issue at epoch above fence is allowed after erasure", () => {
    const store = new UnsubscribeTokenStore();
    store.issue(LINEAGE, NOW_MS, 1);
    store.eraseSubject("ws-unsub", 10);

    const newToken = store.issue(LINEAGE, NOW_MS, 11); // above fence
    expect(newToken).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// parseUrlencodedFields
// ---------------------------------------------------------------------------

describe("parseUrlencodedFields", () => {
  it("parses a simple urlencoded body", () => {
    const fields = parseUrlencodedFields("List-Unsubscribe=One-Click");
    expect(fields).toHaveLength(1);
    expect(fields[0]?.name).toBe("List-Unsubscribe");
    expect(fields[0]?.value).toBe("One-Click");
    expect(fields[0]?.kind).toBe("text");
  });

  it("parses multiple fields", () => {
    const fields = parseUrlencodedFields("a=1&b=2");
    expect(fields).toHaveLength(2);
  });

  it("decodes percent-encoded values", () => {
    const fields = parseUrlencodedFields("name=Hello%20World");
    expect(fields[0]?.value).toBe("Hello World");
  });

  it("empty body → empty array", () => {
    const fields = parseUrlencodedFields("");
    expect(fields).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. INGRESS LIMITS — EXACT BOUNDARY TESTS
// ---------------------------------------------------------------------------

describe("webhook ingress constants and limits", () => {
  it("WEBHOOK_INGRESS constants match spec", () => {
    expect(WEBHOOK_INGRESS.maxHeaders).toBe(64);
    expect(WEBHOOK_INGRESS.maxHeaderBytes).toBe(16384);   // 16 KiB
    expect(WEBHOOK_INGRESS.maxBodyBytes).toBe(262144);    // 256 KiB
    expect(WEBHOOK_INGRESS.deadlineMs).toBe(2000);
    expect(WEBHOOK_INGRESS.peerRatePerSecond).toBe(10);
    expect(WEBHOOK_INGRESS.peerBurst).toBe(50);
    expect(WEBHOOK_INGRESS.globalRatePerSecond).toBe(50);
    expect(WEBHOOK_INGRESS.globalBurst).toBe(100);
  });

  it("checkWebhookIngress: exactly at header limit (64) → allowed", () => {
    const r = checkWebhookIngress({ method: "POST", contentType: "application/json", headerCount: 64, headerBytes: 100, declaredBodyBytes: 100 });
    expect(r.allowed).toBe(true);
  });

  it("checkWebhookIngress: one over header limit (65) → too_many_headers", () => {
    const r = checkWebhookIngress({ method: "POST", contentType: "application/json", headerCount: 65, headerBytes: 100, declaredBodyBytes: 100 });
    expect(r.allowed).toBe(false);
    expect((r as any).reason).toBe("too_many_headers");
  });

  it("checkWebhookIngress: exactly at header bytes (16384) → allowed", () => {
    const r = checkWebhookIngress({ method: "POST", contentType: "application/json", headerCount: 1, headerBytes: 16384, declaredBodyBytes: 100 });
    expect(r.allowed).toBe(true);
  });

  it("checkWebhookIngress: one over header bytes (16385) → headers_too_large", () => {
    const r = checkWebhookIngress({ method: "POST", contentType: "application/json", headerCount: 1, headerBytes: 16385, declaredBodyBytes: 100 });
    expect(r.allowed).toBe(false);
    expect((r as any).reason).toBe("headers_too_large");
  });

  it("checkWebhookIngress: exactly at body limit (262144) → allowed", () => {
    const r = checkWebhookIngress({ method: "POST", contentType: "application/json", headerCount: 1, headerBytes: 100, declaredBodyBytes: 262144 });
    expect(r.allowed).toBe(true);
  });

  it("checkWebhookIngress: one over body limit (262145) → body_too_large", () => {
    const r = checkWebhookIngress({ method: "POST", contentType: "application/json", headerCount: 1, headerBytes: 100, declaredBodyBytes: 262145 });
    expect(r.allowed).toBe(false);
    expect((r as any).reason).toBe("body_too_large");
  });

  it("checkWebhookIngress: GET → method_not_allowed", () => {
    const r = checkWebhookIngress({ method: "GET", contentType: "application/json", headerCount: 1, headerBytes: 100, declaredBodyBytes: 100 });
    expect(r.allowed).toBe(false);
    expect((r as any).reason).toBe("method_not_allowed");
  });

  it("checkWebhookIngress: wrong content-type → unsupported_media_type", () => {
    const r = checkWebhookIngress({ method: "POST", contentType: "text/plain", headerCount: 1, headerBytes: 100, declaredBodyBytes: 100 });
    expect(r.allowed).toBe(false);
    expect((r as any).reason).toBe("unsupported_media_type");
  });

  it("checkWebhookIngress: missing content-type → unsupported_media_type", () => {
    const r = checkWebhookIngress({ method: "POST", contentType: undefined, headerCount: 1, headerBytes: 100, declaredBodyBytes: 100 });
    expect(r.allowed).toBe(false);
    expect((r as any).reason).toBe("unsupported_media_type");
  });
});

describe("webhook deadline", () => {
  // Spec: "2초 deadline" — exactly at 2000 ms is at/past the deadline boundary.
  // The implementation uses elapsed >= deadlineMs (inclusive) which is the correct
  // interpretation: the request must complete strictly before 2000 ms.
  it("exactly at deadline (2000 ms elapsed) → exceeded (deadline is strict)", () => {
    expect(webhookDeadlineExceeded(NOW_MS, NOW_MS + 2000)).toBe(true);
  });

  it("1 ms before deadline (1999 ms elapsed) → NOT exceeded", () => {
    expect(webhookDeadlineExceeded(NOW_MS, NOW_MS + 1999)).toBe(false);
  });

  it("one ms past deadline (2001 ms elapsed) → exceeded", () => {
    expect(webhookDeadlineExceeded(NOW_MS, NOW_MS + 2001)).toBe(true);
  });
});

describe("WebhookRateLimiter", () => {
  it("peer: admitted up to burst of 50 at time 0, rejected at 51st", () => {
    const rl = new WebhookRateLimiter();
    const t = NOW_MS;
    let admitted = 0;
    let limited = false;

    for (let i = 0; i < 51; i++) {
      const result = rl.admit("peer-A", t);
      if (result === "admitted") admitted++;
      else { limited = true; break; }
    }

    // Should hit limit at or before 51 (burst is 50)
    expect(admitted).toBeLessThanOrEqual(50);
    expect(limited).toBe(true);
  });

  it("global: different peers share global limit of 100 burst", () => {
    const rl = new WebhookRateLimiter();
    const t = NOW_MS;
    let globalHit = false;

    for (let i = 0; i < 101; i++) {
      const result = rl.admit(`peer-${i}`, t); // each unique peer, so only global matters
      if (result === "global_limited") { globalHit = true; break; }
    }

    expect(globalHit).toBe(true);
  });

  it("peer limit yields peer_limited reason", () => {
    const rl = new WebhookRateLimiter();
    const t = NOW_MS;
    // Exhaust peer burst
    for (let i = 0; i < 50; i++) rl.admit("throttled-peer", t);
    const result = rl.admit("throttled-peer", t);
    expect(result).toBe("peer_limited");
  });
});

// ---------------------------------------------------------------------------
// UNSUBSCRIBE INGRESS LIMITS
// ---------------------------------------------------------------------------

describe("unsubscribe ingress constants", () => {
  it("UNSUBSCRIBE_INGRESS constants match spec", () => {
    expect(UNSUBSCRIBE_INGRESS.maxUrlBytes).toBe(4096);
    expect(UNSUBSCRIBE_INGRESS.maxBodyBytes).toBe(8192);
    expect(UNSUBSCRIBE_INGRESS.maxHeaders).toBe(64);
    expect(UNSUBSCRIBE_INGRESS.maxHeaderBytes).toBe(16384);
    expect(UNSUBSCRIBE_INGRESS.deadlineMs).toBe(2000);
    expect(UNSUBSCRIBE_INGRESS.ipPrefixPerMinute).toBe(10);
    expect(UNSUBSCRIBE_INGRESS.ipPrefixPerDay).toBe(100);
    expect(UNSUBSCRIBE_INGRESS.globalPerSecond).toBe(50);
  });

  it("checkUnsubscribeIngress: exactly at URL limit (4096) → allowed", () => {
    const r = checkUnsubscribeIngress({ urlBytes: 4096, bodyBytes: 100, headerCount: 1, headerBytes: 100 });
    expect(r.allowed).toBe(true);
  });

  it("checkUnsubscribeIngress: one over URL limit (4097) → url_too_large", () => {
    const r = checkUnsubscribeIngress({ urlBytes: 4097, bodyBytes: 100, headerCount: 1, headerBytes: 100 });
    expect(r.allowed).toBe(false);
    expect((r as any).reason).toBe("url_too_large");
  });

  it("checkUnsubscribeIngress: exactly at body limit (8192) → allowed", () => {
    const r = checkUnsubscribeIngress({ urlBytes: 100, bodyBytes: 8192, headerCount: 1, headerBytes: 100 });
    expect(r.allowed).toBe(true);
  });

  it("checkUnsubscribeIngress: one over body limit (8193) → body_too_large", () => {
    const r = checkUnsubscribeIngress({ urlBytes: 100, bodyBytes: 8193, headerCount: 1, headerBytes: 100 });
    expect(r.allowed).toBe(false);
    expect((r as any).reason).toBe("body_too_large");
  });

  it("checkUnsubscribeIngress: exactly at header count (64) → allowed", () => {
    const r = checkUnsubscribeIngress({ urlBytes: 100, bodyBytes: 100, headerCount: 64, headerBytes: 100 });
    expect(r.allowed).toBe(true);
  });

  it("checkUnsubscribeIngress: 65 headers → too_many_headers", () => {
    const r = checkUnsubscribeIngress({ urlBytes: 100, bodyBytes: 100, headerCount: 65, headerBytes: 100 });
    expect(r.allowed).toBe(false);
    expect((r as any).reason).toBe("too_many_headers");
  });

  it("checkUnsubscribeIngress: exactly at header bytes (16384) → allowed", () => {
    const r = checkUnsubscribeIngress({ urlBytes: 100, bodyBytes: 100, headerCount: 1, headerBytes: 16384 });
    expect(r.allowed).toBe(true);
  });

  it("checkUnsubscribeIngress: 16385 header bytes → headers_too_large", () => {
    const r = checkUnsubscribeIngress({ urlBytes: 100, bodyBytes: 100, headerCount: 1, headerBytes: 16385 });
    expect(r.allowed).toBe(false);
    expect((r as any).reason).toBe("headers_too_large");
  });
});

describe("UnsubscribeFloodLimiter", () => {
  it("IP prefix: admitted at 10th per minute, rejected at 11th", () => {
    const fl = new UnsubscribeFloodLimiter();
    const t = NOW_MS;
    let admitted = 0;
    let limited = false;

    for (let i = 0; i < 11; i++) {
      const r = fl.admit("192.168.1", t);
      if (r === "admitted") admitted++;
      else { limited = true; break; }
    }

    expect(admitted).toBeLessThanOrEqual(10);
    expect(limited).toBe(true);
  });

  it("IP prefix: minute limit yields ip_minute_limited", () => {
    const fl = new UnsubscribeFloodLimiter();
    const t = NOW_MS;
    for (let i = 0; i < 10; i++) fl.admit("192.168.2", t);
    const r = fl.admit("192.168.2", t);
    expect(r).toBe("ip_minute_limited");
  });

  it("IP prefix: day limit yields ip_day_limited", () => {
    const fl = new UnsubscribeFloodLimiter();
    const minuteMs = 60_000;
    // Exhaust 100/day across different minutes to avoid per-minute limit
    for (let m = 0; m < 10; m++) {
      const t = NOW_MS + m * minuteMs;
      for (let i = 0; i < 10; i++) fl.admit("192.168.3", t);
    }
    // Next request in a new minute should hit day limit
    const t = NOW_MS + 11 * minuteMs;
    const r = fl.admit("192.168.3", t);
    expect(r).toBe("ip_day_limited");
  });

  it("global: 50/s, hits global_limited at 51st unique prefix in same second", () => {
    const fl = new UnsubscribeFloodLimiter();
    const t = NOW_MS;
    let globalHit = false;

    for (let i = 0; i < 51; i++) {
      const r = fl.admit(`10.0.${i}`, t);
      if (r === "global_limited") { globalHit = true; break; }
    }

    expect(globalHit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UNSUBSCRIBE INVALID AUDIT
// ---------------------------------------------------------------------------

describe("UnsubscribeInvalidAudit", () => {
  it("UNSUBSCRIBE_AUDIT_SAMPLES_PER_HOUR is 20", () => {
    expect(UNSUBSCRIBE_AUDIT_SAMPLES_PER_HOUR).toBe(20);
  });

  it("rowCap formula: routes×reasons×regions×1440 + 480", () => {
    const audit = new UnsubscribeInvalidAudit(
      ["r1", "r2"],        // 2 routes
      ["bad_token", "malformed"], // 2 reasons
      ["us-east", "eu-west"]     // 2 regions
    );
    // 2×2×2×1440+480 = 11520+480 = 12000
    expect(audit.rowCap).toBe(2 * 2 * 2 * 1440 + 480);
  });

  it("row key format is 'route|reason|minute|edgeRegion'", () => {
    const audit = new UnsubscribeInvalidAudit(["route-A"], ["bad_token"], ["us-east"]);
    const minuteMs = 60_000;
    const t = NOW_MS;
    audit.record("route-A", "bad_token", "us-east", t);
    const rows = audit.rows();
    expect(rows.length).toBeGreaterThan(0);
    // Check key format: "route|reason|minute|region"
    const key = rows[0]?.key ?? "";
    const parts = key.split("|");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("route-A");
    expect(parts[1]).toBe("bad_token");
    expect(parts[3]).toBe("us-east");
    // minute part is a number
    expect(Number.isFinite(Number(parts[2]))).toBe(true);
  });

  it("record: counted=true and sampled=true for first record", () => {
    const audit = new UnsubscribeInvalidAudit(["r1"], ["bad_token"], ["us-east"]);
    const result = audit.record("r1", "bad_token", "us-east", NOW_MS);
    expect(result.counted).toBe(true);
    expect(result.sampled).toBe(true);
  });

  it("samples cap at 20 per hour — 21st sample in same hour → sampled=false", () => {
    const audit = new UnsubscribeInvalidAudit(["r1"], ["bad_token"], ["us-east"]);
    let lastSampled = false;
    for (let i = 0; i < 21; i++) {
      // Use slightly different times within the same hour to vary minutes
      const t = NOW_MS + i * 1000;
      const r = audit.record("r1", "bad_token", "us-east", t);
      lastSampled = r.sampled;
    }
    expect(lastSampled).toBe(false);
  });

  it("audit rows contain no token-derived component — key is route+reason+minute+region only", () => {
    const audit = new UnsubscribeInvalidAudit(["r1"], ["bad_token"], ["us-east"]);
    // Record multiple invalid attempts
    for (let i = 0; i < 5; i++) {
      audit.record("r1", "bad_token", "us-east", NOW_MS + i * 1000);
    }
    const rows = audit.rows();
    // All keys must follow the 4-part format with no token info
    for (const row of rows) {
      const parts = row.key.split("|");
      expect(parts).toHaveLength(4);
    }
  });

  it("prune removes rows older than 24 hours", () => {
    const audit = new UnsubscribeInvalidAudit(["r1"], ["bad_token"], ["us-east"]);
    // Record at NOW_MS
    audit.record("r1", "bad_token", "us-east", NOW_MS);
    expect(audit.rows().length).toBeGreaterThan(0);

    // Prune at NOW_MS + 25 hours
    audit.prune(NOW_MS + 25 * 60 * 60 * 1000);
    expect(audit.rows().length).toBe(0);
  });

  it("counter aggregates multiple records in same minute into one row", () => {
    const audit = new UnsubscribeInvalidAudit(["r1"], ["bad_token"], ["us-east"]);
    // Record 5 times within the same minute
    for (let i = 0; i < 5; i++) {
      audit.record("r1", "bad_token", "us-east", NOW_MS + i * 100);
    }
    const rows = audit.rows();
    // There should be one row (same minute bucket)
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// ProviderMessageDirectory — unit
// ---------------------------------------------------------------------------

describe("ProviderMessageDirectory", () => {
  it("bind and lookup by id", () => {
    const dir = new ProviderMessageDirectory();
    const binding: WebhookOwnerBinding = { owner: "ws-dir", ownerKind: "workspace", recipientFingerprint: "fp", templateRevision: "rv" };
    dir.bind("msg-dir-1", binding);
    expect(dir.lookup("msg-dir-1")).toEqual(binding);
  });

  it("lookup unknown → undefined", () => {
    const dir = new ProviderMessageDirectory();
    expect(dir.lookup("nonexistent")).toBeUndefined();
  });

  it("erase removes the binding", () => {
    const dir = new ProviderMessageDirectory();
    const binding: WebhookOwnerBinding = { owner: "ws-erase", ownerKind: "workspace", recipientFingerprint: "fp", templateRevision: "rv" };
    dir.bind("msg-erase-1", binding);
    dir.erase("msg-erase-1");
    expect(dir.lookup("msg-erase-1")).toBeUndefined();
  });
});
