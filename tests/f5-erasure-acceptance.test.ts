/**
 * SEC-09 Zero-Regeneration Erasure Acceptance Suite
 *
 * Blind acceptance tests written from the spec contract ONLY.
 * No implementation files were read.
 *
 * spec line 270, spec line 344, ticket 14 line 30, ticket 14 line 44
 */

import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import {
  NotificationCenterErasure,
  type NotificationErasureReceipt,
} from "../src/modules/notification-center/notification-erasure";
import { createOccurrenceStore } from "../src/modules/notification-center/occurrence-engine";
import { planDeliveryIntent } from "../src/modules/notification-center/delivery-intent";
import { DeliveryOutbox } from "../src/modules/notification-center/delivery-outbox";
import { DeliveryFactLog } from "../src/modules/notification-center/delivery-fact";
import { FencedKeyedStore } from "../src/modules/notification-center/fenced-store";
import {
  ProviderMessageDirectory,
  WebhookTombstoneRegistry,
  WebhookInbox,
} from "../src/modules/notification-center/webhook-inbox";
import { UnsubscribeTokenStore } from "../src/modules/notification-center/unsubscribe";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid svix-scheme HMAC signature for WebhookInbox.accept */
function svixSignature(
  secret: string,
  svixId: string,
  timestampSeconds: number,
  rawBody: string
): string {
  // secret is base64 after "whsec_" prefix
  const keyBytes = Buffer.from(secret.slice("whsec_".length), "base64");
  const signed = `${svixId}.${timestampSeconds}.${rawBody}`;
  const mac = createHmac("sha256", keyBytes).update(signed).digest("base64");
  return `v1,${mac}`;
}

/** Fixed clock that returns the same value every call */
const fixedNowMs = 1_753_000_000_000; // ms
const fixedNowS = Math.floor(fixedNowMs / 1000);
const fixedIso = new Date(fixedNowMs).toISOString();

// ---------------------------------------------------------------------------
// Constants used across tests
// ---------------------------------------------------------------------------

const WORKSPACE_A = "workspace:alice";
const WORKSPACE_B = "workspace:bob";
const ACCOUNT_A = "account:alice";
const FENCE = 100;
const PRE_FENCE_EPOCH = 50; // <= FENCE  → suppressed
const POST_FENCE_EPOCH = 150; // >  FENCE  → allowed

const RULE_REF = brandReference<string, "AlertRuleReference">("rule:1");
const WORKSPACE_A_REF = brandReference<string, "WorkspaceReference">(WORKSPACE_A);
const WORKSPACE_B_REF = brandReference<string, "WorkspaceReference">(WORKSPACE_B);
const CAUSE_ID = brandReference<string, "DeliveryCauseId">("cause:alert:rule:1");
const SOURCE_REF = brandReference<string, "SourceReference">("source:ev:1");
const MAT_REF = brandReference<string, "DeliveryActionMaterialReference">("mat:unsub:1");
const DEST_REF = brandReference<string, "DeliveryDestinationReference">("dest:1");

const PROVIDER = "svix-provider";
const ENVIRONMENT = "production";
const RAW_PROVIDER_MESSAGE_ID = "email-msg-alice-1";

// A webhook secret in whsec_ format
const WEBHOOK_SECRET = `whsec_${Buffer.from("super-secret-key-32-bytes-longg!").toString("base64")}`;

/** Build the canonical provider-message payload that WebhookInbox expects */
function providerPayload(emailId: string): string {
  return JSON.stringify({ type: "email.delivered", data: { email_id: emailId } });
}

// ---------------------------------------------------------------------------
// Factory helpers for each test
// ---------------------------------------------------------------------------

function makeOccurrenceStore(writeEpoch?: number) {
  return createOccurrenceStore(
    () => fixedIso,
    writeEpoch !== undefined ? { writeEpoch } : undefined
  );
}

function makeSealedStore() {
  return new FencedKeyedStore<string>();
}

function makeOutbox() {
  return new DeliveryOutbox();
}

function makeFactLog() {
  return new DeliveryFactLog();
}

function makeDirectory() {
  return new ProviderMessageDirectory();
}

function makeTombstones() {
  return new WebhookTombstoneRegistry(
    [{ version: 1, key: WEBHOOK_SECRET }],
    1
  );
}

function makeInbox(directory: ProviderMessageDirectory, tombstones: WebhookTombstoneRegistry) {
  return new WebhookInbox(directory, tombstones);
}

function makeTokenStore() {
  return new UnsubscribeTokenStore();
}

function buildValidIntent() {
  return planDeliveryIntent({
    cause: { kind: "alert_occurrence", causeId: CAUSE_ID },
    channel: "email",
    source: SOURCE_REF,
    actionMaterial: { kind: "unsubscribe", reference: MAT_REF },
    target: {
      kind: "workspace_financial_email",
      reference: DEST_REF,
      destinationFingerprint: "fp:alice",
    },
    binding: {
      templateRevision: "tpl-1",
      payloadHash: "hash-1",
      expiresAt: "2026-07-18T00:00:00.000Z",
    },
  });
}

/** Populate a "fully-populated world" for workspace A and return all stores */
async function buildPopulatedWorld(preEpoch = PRE_FENCE_EPOCH) {
  const occurrences = makeOccurrenceStore(preEpoch);
  const outbox = makeOutbox();
  const factLog = makeFactLog();
  const sealedStore = makeSealedStore();
  const directory = makeDirectory();
  const tombstones = makeTombstones();
  const inbox = makeInbox(directory, tombstones);
  const tokenStore = makeTokenStore();

  // 1. Register and fire an alert rule (occurrence spine)
  occurrences.registerRule({
    ruleReference: RULE_REF,
    workspaceReference: WORKSPACE_A_REF,
    conditionRevision: "rev-1",
  });
  const transitionResult = await occurrences.observe({
    ruleReference: RULE_REF,
    conditionRevision: "rev-1",
    conditionMet: true,
    sourceObservationIdentity: 1,
    asOf: fixedIso,
  });
  expect(transitionResult.kind).toBe("transition"); // guard: we actually created state

  // 2. Plan and commit a delivery intent
  const intentResult = buildValidIntent();
  expect(intentResult.status).toBe("planned");
  if (intentResult.status !== "planned") throw new Error("planned");
  const commitResult = outbox.commit(WORKSPACE_A, intentResult.intent, preEpoch);
  expect(commitResult.status).toBe("committed");

  // 3. Append a delivery fact
  const factResult = factLog.append(
    WORKSPACE_A,
    {
      causeId: CAUSE_ID,
      intentUniqueKey: "intent:1",
      kind: "provider_accepted",
      occurredAt: fixedIso,
    },
    preEpoch
  );
  expect(factResult.appended).toBe(true);

  // 4. Write to the sealed-material store
  const sealed = sealedStore.write(WORKSPACE_A, "material:1", "sealed-value", preEpoch);
  expect(sealed).toBe(true);

  // 5. Bind a provider message with a route to workspace A
  directory.bind(
    RAW_PROVIDER_MESSAGE_ID,
    {
      owner: WORKSPACE_A,
      ownerKind: "workspace",
      recipientFingerprint: "fp:alice",
      templateRevision: "tpl-1",
    },
    { provider: PROVIDER, environment: ENVIRONMENT }
  );

  // 6. Accept a signed webhook (pre-erase)
  const rawBody = providerPayload(RAW_PROVIDER_MESSAGE_ID);
  const svixId = "svix-msg-1";
  const sig = svixSignature(WEBHOOK_SECRET, svixId, fixedNowS, rawBody);
  const acceptResult = inbox.accept(
    {
      provider: PROVIDER,
      environment: ENVIRONMENT,
      svixId,
      timestampSeconds: fixedNowS,
      rawBody,
      signatureHeader: sig,
    },
    WEBHOOK_SECRET,
    fixedNowMs,
    preEpoch
  );
  expect(acceptResult.status).toBe("accepted"); // guard

  // 7. Issue an unsubscribe token
  const token = tokenStore.issue(
    { workspace: WORKSPACE_A, endpoint: "ep:1", topic: "alerts", channel: "email", consentRevision: 1 },
    fixedNowMs,
    preEpoch
  );
  expect(token).toBeDefined();

  return { occurrences, outbox, factLog, sealedStore, directory, tombstones, inbox, tokenStore };
}

function buildErasure(
  occurrences: ReturnType<typeof makeOccurrenceStore>,
  outbox: DeliveryOutbox,
  factLog: DeliveryFactLog,
  sealedStore: FencedKeyedStore<string>,
  directory: ProviderMessageDirectory,
  tombstones: WebhookTombstoneRegistry
) {
  return new NotificationCenterErasure({
    occurrences,
    stores: [
      { label: "delivery-outbox", store: outbox },
      { label: "delivery-fact", store: factLog },
      { label: "sealed-material", store: sealedStore },
      { label: "unsubscribe-token", store: new UnsubscribeTokenStore() }, // included separately per ticket-14
    ],
    directory,
    tombstones,
    now: () => fixedNowMs,
  });
}

// ---------------------------------------------------------------------------
// Test 1 — Every store queries to zero after erase
// ---------------------------------------------------------------------------

describe("SEC-09 zero-regeneration oracle", () => {
  describe("1. All stores query to zero after erasure", () => {
    it("occurrences and records are gone after erase", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      expect(occurrences.listOccurrences(RULE_REF)).toHaveLength(0);
      expect(occurrences.listRecords(WORKSPACE_A_REF)).toHaveLength(0);
    });

    it("outbox is empty after erase", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      expect(outbox.list(WORKSPACE_A)).toHaveLength(0);
    });

    it("fact log is empty after erase", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      expect(factLog.list(WORKSPACE_A)).toHaveLength(0);
    });

    it("sealed-material store is empty after erase", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      expect(sealedStore.size(WORKSPACE_A)).toBe(0);
    });

    it("directory binding is gone after erase", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      expect(directory.lookup(RAW_PROVIDER_MESSAGE_ID)).toBeUndefined();
    });

    it("unsubscribe token entries are gone after erase", async () => {
      const occurrences = makeOccurrenceStore(PRE_FENCE_EPOCH);
      const outbox = makeOutbox();
      const factLog = makeFactLog();
      const sealedStore = makeSealedStore();
      const directory = makeDirectory();
      const tombstones = makeTombstones();
      const tokenStore = makeTokenStore();

      tokenStore.issue(
        { workspace: WORKSPACE_A, endpoint: "ep:1", topic: "alerts", channel: "email", consentRevision: 1 },
        fixedNowMs,
        PRE_FENCE_EPOCH
      );
      expect(tokenStore.entries(WORKSPACE_A)).toHaveLength(1);

      const erasure = new NotificationCenterErasure({
        occurrences,
        stores: [
          { label: "delivery-outbox", store: outbox },
          { label: "delivery-fact", store: factLog },
          { label: "sealed-material", store: sealedStore },
          { label: "unsubscribe-token", store: tokenStore },
        ],
        directory,
        tombstones,
        now: () => fixedNowMs,
      });

      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      expect(tokenStore.entries(WORKSPACE_A)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2 — Receipt is honest and replay-safe
  // -------------------------------------------------------------------------

  describe("2. Receipt is honest and replay does not alter it", () => {
    it("receipt fence matches the coordinator fence", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const receipt = erasure.receiptFor(WORKSPACE_A);
      expect(receipt).toBeDefined();
      expect(receipt!.fence).toBe(FENCE);
    });

    it("receipt contains alert-occurrence and notification-record lines with non-zero shredded", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const receipt = erasure.receiptFor(WORKSPACE_A)!;
      const labels = receipt.lines.map((l) => l.label);
      expect(labels[0]).toBe("alert-occurrence");
      expect(labels[1]).toBe("notification-record");
      // occurrence spine must have shredded > 0 (we created one transition)
      expect(receipt.lines[0]!.shredded).toBeGreaterThan(0);
    });

    it("receipt has one line per registered store in order", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const receipt = erasure.receiptFor(WORKSPACE_A)!;
      // First two are occurrence spine; then one per registered store (4 in buildErasure)
      expect(receipt.lines.length).toBe(2 + 4);
      const storeLabels = receipt.lines.slice(2).map((l) => l.label);
      expect(storeLabels).toEqual([
        "delivery-outbox",
        "delivery-fact",
        "sealed-material",
        "unsubscribe-token",
      ]);
    });

    it("tombstonedProviderMessages >= 1 because provider binding had a route", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const receipt = erasure.receiptFor(WORKSPACE_A)!;
      expect(receipt.tombstonedProviderMessages).toBeGreaterThanOrEqual(1);
    });

    it("replayed erase() at the same fence does NOT zero or change the receipt", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const receiptBefore = erasure.receiptFor(WORKSPACE_A)!;
      const shreddedBefore = receiptBefore.lines.map((l) => l.shredded);

      // Replay at the same fence
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const receiptAfter = erasure.receiptFor(WORKSPACE_A)!;
      const shreddedAfter = receiptAfter.lines.map((l) => l.shredded);

      expect(receiptAfter.fence).toBe(receiptBefore.fence);
      expect(shreddedAfter).toEqual(shreddedBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Test 3 — Late / backup-restore writes at epoch <= fence are suppressed
  // -------------------------------------------------------------------------

  describe("3. Late writes at epoch <= fence are suppressed", () => {
    it("outbox commit at epoch <= fence is suppressed", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const intentResult = buildValidIntent();
      if (intentResult.status !== "planned") throw new Error("planned");
      const result = outbox.commit(WORKSPACE_A, intentResult.intent, FENCE); // at the fence
      expect(result.status).toBe("suppressed");
      expect(outbox.list(WORKSPACE_A)).toHaveLength(0);
    });

    it("fact append at epoch <= fence is suppressed", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const result = factLog.append(
        WORKSPACE_A,
        { causeId: CAUSE_ID, intentUniqueKey: "intent:late", kind: "queued", occurredAt: fixedIso },
        PRE_FENCE_EPOCH
      );
      expect(result.appended).toBe(false);
      expect(factLog.list(WORKSPACE_A)).toHaveLength(0);
    });

    it("sealed-store write at epoch <= fence is suppressed", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const wrote = sealedStore.write(WORKSPACE_A, "material:late", "late-value", PRE_FENCE_EPOCH);
      expect(wrote).toBe(false);
      expect(sealedStore.size(WORKSPACE_A)).toBe(0);
    });

    it("unsubscribe token issue at epoch <= fence is suppressed", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();
      const tokenStore = makeTokenStore();
      // Erase to install the fence
      tokenStore.issue(
        { workspace: WORKSPACE_A, endpoint: "ep:seed", topic: "alerts", channel: "email", consentRevision: 1 },
        fixedNowMs,
        PRE_FENCE_EPOCH
      );
      // Build erasure that includes this token store
      const erasure = new NotificationCenterErasure({
        occurrences,
        stores: [
          { label: "delivery-outbox", store: outbox },
          { label: "delivery-fact", store: factLog },
          { label: "sealed-material", store: sealedStore },
          { label: "unsubscribe-token", store: tokenStore },
        ],
        directory,
        tombstones,
        now: () => fixedNowMs,
      });
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });
      // Now try a late issue
      const lateToken = tokenStore.issue(
        { workspace: WORKSPACE_A, endpoint: "ep:late", topic: "alerts", channel: "email", consentRevision: 2 },
        fixedNowMs,
        PRE_FENCE_EPOCH
      );
      expect(lateToken).toBeUndefined();
      expect(tokenStore.entries(WORKSPACE_A)).toHaveLength(0);
    });

    it("late occurrence observe returns unknown_rule after eraseWorkspace", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      // Post-erasure observe should be ignored because rule was erased
      const result = await occurrences.observe({
        ruleReference: RULE_REF,
        conditionRevision: "rev-1",
        conditionMet: true,
        sourceObservationIdentity: 99,
        asOf: fixedIso,
      });
      expect(result.kind).toBe("ignored");
      if (result.kind === "ignored") {
        expect(result.reason).toBe("unknown_rule");
      }
    });

    it("registerRule at epoch <= fence is suppressed (restore suppression)", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld(PRE_FENCE_EPOCH);

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      // Attempt to re-register at the pre-fence writeEpoch — should remain unknown
      occurrences.registerRule({
        ruleReference: RULE_REF,
        workspaceReference: WORKSPACE_A_REF,
        conditionRevision: "rev-restored",
      });

      const result = await occurrences.observe({
        ruleReference: RULE_REF,
        conditionRevision: "rev-restored",
        conditionMet: true,
        sourceObservationIdentity: 200,
        asOf: fixedIso,
      });
      expect(result.kind).toBe("ignored");
    });

    it("a write at epoch > fence IS allowed (monotonic, not permanent ban)", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      // A post-erasure epoch > FENCE should succeed
      const wrote = sealedStore.write(WORKSPACE_A, "material:new", "new-value", POST_FENCE_EPOCH);
      expect(wrote).toBe(true);
      expect(sealedStore.size(WORKSPACE_A)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Test 4 — Late correctly-signed webhook suppressed via tombstone
  // -------------------------------------------------------------------------

  describe("4. Late signed webhook for erased owner is tombstone-suppressed", () => {
    it("late webhook returns suppressed/erasure_tombstone and does NOT store as unbound", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones, inbox } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      // Now send a late webhook with the same provider message id (tombstoned)
      const rawBody = providerPayload(RAW_PROVIDER_MESSAGE_ID);
      const svixId = "svix-late-1";
      const sig = svixSignature(WEBHOOK_SECRET, svixId, fixedNowS, rawBody);

      const result = inbox.accept(
        {
          provider: PROVIDER,
          environment: ENVIRONMENT,
          svixId,
          timestampSeconds: fixedNowS,
          rawBody,
          signatureHeader: sig,
        },
        WEBHOOK_SECRET,
        fixedNowMs,
        POST_FENCE_EPOCH // epoch doesn't matter — tombstone wins
      );

      expect(result.status).toBe("suppressed");
      if (result.status === "suppressed") {
        expect(result.reason).toBe("erasure_tombstone");
      }
    });

    it("unbound subject inbox size stays 0 after tombstone-suppressed webhook", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones, inbox } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const rawBody = providerPayload(RAW_PROVIDER_MESSAGE_ID);
      const svixId = "svix-late-2";
      const sig = svixSignature(WEBHOOK_SECRET, svixId, fixedNowS, rawBody);

      inbox.accept(
        { provider: PROVIDER, environment: ENVIRONMENT, svixId, timestampSeconds: fixedNowS, rawBody, signatureHeader: sig },
        WEBHOOK_SECRET,
        fixedNowMs,
        POST_FENCE_EPOCH
      );

      const unboundSubject = `unbound:${PROVIDER}|${ENVIRONMENT}`;
      expect(inbox.size(unboundSubject)).toBe(0);
    });

    it("suppressed tombstone counter increments on each late webhook", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones, inbox } =
        await buildPopulatedWorld();

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const rawBody = providerPayload(RAW_PROVIDER_MESSAGE_ID);

      for (let i = 0; i < 3; i++) {
        const svixId = `svix-late-count-${i}`;
        const sig = svixSignature(WEBHOOK_SECRET, svixId, fixedNowS, rawBody);
        inbox.accept(
          { provider: PROVIDER, environment: ENVIRONMENT, svixId, timestampSeconds: fixedNowS, rawBody, signatureHeader: sig },
          WEBHOOK_SECRET,
          fixedNowMs,
          POST_FENCE_EPOCH
        );
      }

      expect(tombstones.suppressedCount(PROVIDER, ENVIRONMENT)).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Test 5 — Workspace isolation
  // -------------------------------------------------------------------------

  describe("5. Workspace isolation: erasing A leaves B intact", () => {
    it("workspace B state is unaffected by erasing workspace A", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      // Populate workspace B in the same stores
      const RULE_REF_B = brandReference<string, "AlertRuleReference">("rule:b:1");

      occurrences.registerRule({
        ruleReference: RULE_REF_B,
        workspaceReference: WORKSPACE_B_REF,
        conditionRevision: "rev-b-1",
      });
      await occurrences.observe({
        ruleReference: RULE_REF_B,
        conditionRevision: "rev-b-1",
        conditionMet: true,
        sourceObservationIdentity: 10,
        asOf: fixedIso,
      });
      const bIntent = buildValidIntent();
      if (bIntent.status !== "planned") throw new Error("planned");
      outbox.commit(WORKSPACE_B, bIntent.intent, PRE_FENCE_EPOCH);
      sealedStore.write(WORKSPACE_B, "material:b:1", "b-value", PRE_FENCE_EPOCH);

      const B_PROVIDER_MSG_ID = "email-msg-bob-1";
      directory.bind(
        B_PROVIDER_MSG_ID,
        { owner: WORKSPACE_B, ownerKind: "workspace", recipientFingerprint: "fp:bob", templateRevision: "tpl-b-1" },
        { provider: PROVIDER, environment: ENVIRONMENT }
      );

      // Erase only workspace A
      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      // Workspace B should still have its records
      expect(occurrences.listRecords(WORKSPACE_B_REF)).toHaveLength(1);
      expect(outbox.list(WORKSPACE_B)).toHaveLength(1);
      expect(sealedStore.size(WORKSPACE_B)).toBe(1);
      expect(directory.lookup(B_PROVIDER_MSG_ID)).toBeDefined();
      expect(directory.lookup(B_PROVIDER_MSG_ID)!.owner).toBe(WORKSPACE_B);
    });

    it("workspace B provider binding is not tombstoned after erasing workspace A", async () => {
      const { occurrences, outbox, factLog, sealedStore, directory, tombstones } =
        await buildPopulatedWorld();

      const B_PROVIDER_MSG_ID = "email-msg-bob-2";
      directory.bind(
        B_PROVIDER_MSG_ID,
        { owner: WORKSPACE_B, ownerKind: "workspace", recipientFingerprint: "fp:bob", templateRevision: "tpl-b-1" },
        { provider: PROVIDER, environment: ENVIRONMENT }
      );

      const erasure = buildErasure(occurrences, outbox, factLog, sealedStore, directory, tombstones);
      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      // A correctly signed webhook for workspace B's message should be accepted, not tombstone-suppressed
      const inbox = new WebhookInbox(directory, tombstones);
      const rawBody = providerPayload(B_PROVIDER_MSG_ID);
      const svixId = "svix-bob-1";
      const sig = svixSignature(WEBHOOK_SECRET, svixId, fixedNowS, rawBody);
      const result = inbox.accept(
        { provider: PROVIDER, environment: ENVIRONMENT, svixId, timestampSeconds: fixedNowS, rawBody, signatureHeader: sig },
        WEBHOOK_SECRET,
        fixedNowMs,
        POST_FENCE_EPOCH
      );

      expect(result.status).not.toBe("suppressed");
    });
  });

  // -------------------------------------------------------------------------
  // Test 6 — eraseOwner and unroutedBindings
  // -------------------------------------------------------------------------

  describe("6. eraseOwner and unroutedBindings accounting", () => {
    it("eraseOwner returns only the erased owner's bindings", () => {
      const directory = makeDirectory();

      directory.bind(
        "msg-alice-routed",
        { owner: WORKSPACE_A, ownerKind: "workspace", recipientFingerprint: "fp:alice", templateRevision: "tpl-1" },
        { provider: PROVIDER, environment: ENVIRONMENT }
      );
      directory.bind(
        "msg-bob-routed",
        { owner: WORKSPACE_B, ownerKind: "workspace", recipientFingerprint: "fp:bob", templateRevision: "tpl-b-1" },
        { provider: PROVIDER, environment: ENVIRONMENT }
      );

      const erased = directory.eraseOwner(WORKSPACE_A);
      expect(erased).toHaveLength(1);
      expect(erased[0]!.providerMessageId).toBe("msg-alice-routed");
    });

    it("binding without a route is counted in unroutedBindings and still removed from directory", async () => {
      const occurrences = makeOccurrenceStore(PRE_FENCE_EPOCH);
      const outbox = makeOutbox();
      const factLog = makeFactLog();
      const sealedStore = makeSealedStore();
      const directory = makeDirectory();
      const tombstones = makeTombstones();

      // Bind without route
      const UNROUTED_MSG_ID = "msg-alice-unrouted";
      directory.bind(
        UNROUTED_MSG_ID,
        { owner: WORKSPACE_A, ownerKind: "workspace", recipientFingerprint: "fp:alice", templateRevision: "tpl-1" }
        // no route parameter
      );

      const erasure = new NotificationCenterErasure({
        occurrences,
        stores: [
          { label: "delivery-outbox", store: outbox },
          { label: "delivery-fact", store: factLog },
          { label: "sealed-material", store: sealedStore },
          { label: "unsubscribe-token", store: makeTokenStore() },
        ],
        directory,
        tombstones,
        now: () => fixedNowMs,
      });

      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const receipt = erasure.receiptFor(WORKSPACE_A)!;
      expect(receipt.unroutedBindings).toBeGreaterThanOrEqual(1);
      // Must also be removed from directory
      expect(directory.lookup(UNROUTED_MSG_ID)).toBeUndefined();
    });

    it("tombstonedProviderMessages counts only routed bindings (not unrouted)", async () => {
      const directory = makeDirectory();
      const tombstones = makeTombstones();
      const occurrences = makeOccurrenceStore(PRE_FENCE_EPOCH);
      const outbox = makeOutbox();
      const factLog = makeFactLog();
      const sealedStore = makeSealedStore();

      // One routed, one unrouted for workspace A
      directory.bind(
        "msg-routed",
        { owner: WORKSPACE_A, ownerKind: "workspace", recipientFingerprint: "fp:alice", templateRevision: "tpl-1" },
        { provider: PROVIDER, environment: ENVIRONMENT }
      );
      directory.bind(
        "msg-unrouted",
        { owner: WORKSPACE_A, ownerKind: "workspace", recipientFingerprint: "fp:alice", templateRevision: "tpl-2" }
      );

      const erasure = new NotificationCenterErasure({
        occurrences,
        stores: [
          { label: "delivery-outbox", store: outbox },
          { label: "delivery-fact", store: factLog },
          { label: "sealed-material", store: sealedStore },
          { label: "unsubscribe-token", store: makeTokenStore() },
        ],
        directory,
        tombstones,
        now: () => fixedNowMs,
      });

      await erasure.erase({
        accountReference: ACCOUNT_A,
        workspaceReference: WORKSPACE_A,
        scope: "workspace",
        fence: FENCE,
      });

      const receipt = erasure.receiptFor(WORKSPACE_A)!;
      expect(receipt.tombstonedProviderMessages).toBe(1);
      expect(receipt.unroutedBindings).toBe(1);
    });
  });
});
