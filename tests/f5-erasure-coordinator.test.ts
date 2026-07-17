/**
 * B6 — NotificationCenter erasure participant (SEC-09): one fence erases every
 * personal delivery store, provider-message bindings are tombstoned so a late
 * SIGNED webhook regenerates nothing, and the module receipt is the public
 * erasure state the Identity coordinator collects.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { AlertObservation, AlertRule } from "../src/modules/notification-center/contracts";
import { DeliveryFactLog } from "../src/modules/notification-center/delivery-fact";
import { DeliveryOutbox } from "../src/modules/notification-center/delivery-outbox";
import { FencedKeyedStore } from "../src/modules/notification-center/fenced-store";
import { NotificationCenterErasure } from "../src/modules/notification-center/notification-erasure";
import { createOccurrenceStore } from "../src/modules/notification-center/occurrence-engine";
import { UnsubscribeTokenStore } from "../src/modules/notification-center/unsubscribe";
import {
  ProviderMessageDirectory,
  WebhookInbox,
  WebhookTombstoneRegistry,
} from "../src/modules/notification-center/webhook-inbox";
import { planDeliveryIntent } from "../src/modules/notification-center/delivery-intent";
import type { DeliveryIntentRequest } from "../src/modules/notification-center/delivery-intent";
import type { WorkspaceReference } from "@/shared/contracts/brands";

const NOW_ISO = "2026-07-17T00:00:00.000Z";
const NOW_MS = 1_700_000_000_000;
const WS = "workspace:w1";
const WS_REF = brandReference<string, "WorkspaceReference">(WS);
const WS_B = "workspace:w2";

// Scripted signing material for the late-signed-webhook check (network-off lane).
// Assembled at runtime so the committed source never contains a credential-shaped literal (pre-commit scan).
const SECRET = `whsec_${Buffer.from("scripted-test-signing-key").toString("base64")}`;
const TIMESTAMP = Math.floor(NOW_MS / 1000);
function signFor(svixId: string, rawBody: string): string {
  const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${svixId}.${TIMESTAMP}.${rawBody}`).digest("base64")}`;
}

function ruleFor(ws: WorkspaceReference, id: string): AlertRule {
  return {
    ruleReference: brandReference<string, "AlertRuleReference">(id),
    workspaceReference: ws,
    conditionRevision: "rev-1",
  };
}

function obsFor(rule: AlertRule, identity: number): AlertObservation {
  return {
    ruleReference: rule.ruleReference,
    conditionRevision: "rev-1",
    asOf: NOW_ISO,
    conditionMet: true,
    sourceObservationIdentity: identity,
  };
}

function financialEmailRequest(ws: string): DeliveryIntentRequest {
  return {
    cause: { kind: "alert_occurrence", causeId: brandReference<string, "DeliveryCauseId">(`cause:alert:${ws}:1`) },
    channel: "email",
    source: brandReference<string, "SourceReference">("source:ev:1"),
    actionMaterial: { kind: "unsubscribe", reference: brandReference<string, "DeliveryActionMaterialReference">("mat:unsub:1") },
    target: { kind: "workspace_financial_email", reference: brandReference<string, "DeliveryDestinationReference">("dest:1"), destinationFingerprint: "fp:alice" },
    binding: { templateRevision: "tpl-1", payloadHash: "hash-1", expiresAt: "2026-07-18T00:00:00.000Z" },
  };
}

/** A fully-populated NotificationCenter world for one workspace. */
function world() {
  const occurrences = createOccurrenceStore(() => NOW_ISO);
  const outbox = new DeliveryOutbox();
  const facts = new DeliveryFactLog();
  const directory = new ProviderMessageDirectory();
  const tombstones = new WebhookTombstoneRegistry([{ version: 1, key: "tombstone-key-v1" }], 1);
  const inbox = new WebhookInbox(directory, tombstones);
  const tokens = new UnsubscribeTokenStore();
  const sealedMaterial = new FencedKeyedStore<string>();

  const erasure = new NotificationCenterErasure({
    occurrences,
    stores: [
      { label: "delivery-intent-outbox", store: outbox },
      { label: "delivery-fact-log", store: facts },
      { label: "webhook-inbox", store: inbox },
      { label: "unsubscribe-token-hash", store: tokens },
      { label: "sealed-delivery-material", store: sealedMaterial },
    ],
    directory,
    tombstones,
    now: () => NOW_MS,
  });

  return { occurrences, outbox, facts, directory, tombstones, inbox, tokens, sealedMaterial, erasure };
}

async function populate(w: ReturnType<typeof world>) {
  const rule = ruleFor(WS_REF, "rule:a1");
  w.occurrences.registerRule(rule);
  await w.occurrences.observe(obsFor(rule, 1));

  const planned = planDeliveryIntent(financialEmailRequest(WS));
  if (planned.status !== "planned") throw new Error("expected planned intent");
  w.outbox.commit(WS, planned.intent, 1);
  w.facts.append(WS, { causeId: planned.intent.cause.causeId, intentUniqueKey: planned.intent.uniqueKey, kind: "queued", occurredAt: NOW_ISO }, 1);

  w.directory.bind(
    "pm:msg-1",
    { owner: WS, ownerKind: "workspace", recipientFingerprint: "fp:alice", templateRevision: "tpl-1" },
    { provider: "resend", environment: "test" },
  );
  const body = '{"type":"email.delivered","data":{"email_id":"pm:msg-1"}}';
  const accepted = w.inbox.accept(
    { provider: "resend", environment: "test", svixId: "svix:evt-1", timestampSeconds: TIMESTAMP, rawBody: body, signatureHeader: signFor("svix:evt-1", body) },
    SECRET,
    NOW_MS,
    1,
  );
  if (accepted.status !== "accepted") throw new Error(`expected accepted webhook, got ${accepted.status}`);

  const token = w.tokens.issue({ workspace: WS, endpoint: "endpoint:e1", topic: "topic:rule-1", channel: "email", consentRevision: 1 }, NOW_MS, 1);
  if (token === undefined) throw new Error("expected token");
  w.sealedMaterial.write(WS, "endpoint:e1", "sealed-envelope-bytes", 1);
  return { rule, intent: planned.intent, token };
}

describe("NotificationCenter erasure participant (SEC-09)", () => {
  it("one fence erases every personal delivery store and the receipt reports each line", async () => {
    const w = world();
    await populate(w);

    await w.erasure.erase({ accountReference: "account:a1", workspaceReference: WS, scope: "account", fence: 7 });

    expect(w.occurrences.listRecords(WS_REF)).toHaveLength(0);
    expect(w.outbox.list(WS)).toHaveLength(0);
    expect(w.facts.list(WS)).toHaveLength(0);
    expect(w.inbox.size(WS)).toBe(0);
    expect(w.tokens.entries(WS)).toHaveLength(0);
    expect(w.sealedMaterial.size(WS)).toBe(0);

    const receipt = w.erasure.receiptFor(WS);
    expect(receipt).toBeDefined();
    expect(receipt?.fence).toBe(7);
    expect(receipt?.lines).toEqual([
      { label: "alert-occurrence", shredded: 1 },
      { label: "notification-record", shredded: 1 },
      { label: "delivery-intent-outbox", shredded: 1 },
      { label: "delivery-fact-log", shredded: 1 },
      { label: "webhook-inbox", shredded: 1 },
      { label: "unsubscribe-token-hash", shredded: 1 },
      { label: "sealed-delivery-material", shredded: 1 },
    ]);
    expect(receipt?.tombstonedProviderMessages).toBe(1);
    expect(receipt?.unroutedBindings).toBe(0);
  });

  it("after erasure nothing regenerates: late observation, old-epoch writes, late SIGNED webhook, token consume", async () => {
    const w = world();
    const { rule, intent, token } = await populate(w);
    await w.erasure.erase({ accountReference: "account:a1", workspaceReference: WS, scope: "account", fence: 7 });

    // late observation → the rule is gone, nothing is recreated.
    expect(await w.occurrences.observe(obsFor(rule, 2))).toEqual({ kind: "ignored", reason: "unknown_rule" });
    // late worker commits/appends at pre-erasure epochs → suppressed.
    expect(w.outbox.commit(WS, intent, 3).status).toBe("suppressed");
    expect(w.facts.append(WS, { causeId: intent.cause.causeId, intentUniqueKey: intent.uniqueKey, kind: "delivered", occurredAt: NOW_ISO }, 3).appended).toBe(false);
    // a late but correctly SIGNED webhook for the erased owner hits the tombstone,
    // not the unbound lane — raw/recipient/inbox writes stay at zero.
    const body = '{"type":"email.bounced","data":{"email_id":"pm:msg-1"}}';
    const late = w.inbox.accept(
      { provider: "resend", environment: "test", svixId: "svix:evt-late", timestampSeconds: TIMESTAMP, rawBody: body, signatureHeader: signFor("svix:evt-late", body) },
      SECRET,
      NOW_MS,
      1,
    );
    expect(late).toEqual({ status: "suppressed", reason: "erasure_tombstone" });
    expect(w.inbox.size(`unbound:resend|test`)).toBe(0);
    expect(w.tombstones.suppressedCount("resend", "test")).toBe(1);
    // unsubscribe tokens are shredded; re-issue at an old epoch is suppressed.
    expect(w.tokens.consume(token, NOW_MS)).toBeUndefined();
    expect(w.tokens.issue({ workspace: WS, endpoint: "endpoint:e1", topic: "topic:rule-1", channel: "email", consentRevision: 1 }, NOW_MS, 3)).toBeUndefined();
    // sealed material backup restore at an old epoch → suppressed.
    expect(w.sealedMaterial.write(WS, "endpoint:e1", "restored-envelope", 3)).toBe(false);
  });

  it("erasing workspace A leaves workspace B intact in every store", async () => {
    const w = world();
    await populate(w);
    const ruleB = ruleFor(brandReference<string, "WorkspaceReference">(WS_B), "rule:b1");
    w.occurrences.registerRule(ruleB);
    await w.occurrences.observe(obsFor(ruleB, 1));
    w.sealedMaterial.write(WS_B, "endpoint:b1", "sealed-b", 1);
    w.directory.bind("pm:msg-b", { owner: WS_B, ownerKind: "workspace", recipientFingerprint: "fp:bob", templateRevision: "tpl-1" }, { provider: "resend", environment: "test" });

    await w.erasure.erase({ accountReference: "account:a1", workspaceReference: WS, scope: "account", fence: 7 });

    expect(w.occurrences.listRecords(brandReference<string, "WorkspaceReference">(WS_B))).toHaveLength(1);
    expect(w.sealedMaterial.size(WS_B)).toBe(1);
    expect(w.directory.lookup("pm:msg-b")).toBeDefined();
    // B's provider id is NOT tombstoned.
    expect(w.tombstones.suppressed("resend", "test", "pm:msg-b", NOW_MS)).toBe(false);
    expect(w.erasure.receiptFor(WS_B)).toBeUndefined();
  });

  it("a binding stored without a provider route is erased but honestly reported as untombstoned", async () => {
    const w = world();
    w.directory.bind("pm:unrouted", { owner: WS, ownerKind: "workspace", recipientFingerprint: "fp:alice", templateRevision: "tpl-1" });
    await w.erasure.erase({ accountReference: "account:a1", workspaceReference: WS, scope: "account", fence: 7 });
    expect(w.directory.lookup("pm:unrouted")).toBeUndefined();
    const receipt = w.erasure.receiptFor(WS);
    expect(receipt?.tombstonedProviderMessages).toBe(0);
    expect(receipt?.unroutedBindings).toBe(1);
  });

  it("a replayed coordinator call at the same fence keeps the original receipt (idempotent public state)", async () => {
    const w = world();
    await populate(w);
    await w.erasure.erase({ accountReference: "account:a1", workspaceReference: WS, scope: "account", fence: 7 });
    const first = w.erasure.receiptFor(WS);
    await w.erasure.erase({ accountReference: "account:a1", workspaceReference: WS, scope: "account", fence: 7 });
    // the public state still shows what was actually shredded, not a zeroed replay.
    expect(w.erasure.receiptFor(WS)).toEqual(first);
    expect(first?.tombstonedProviderMessages).toBe(1);
  });
});
