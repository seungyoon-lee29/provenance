/**
 * B7c — F5 end-to-end integration (AT-10 / AT-11, SEC-06/09).
 *
 * AT-10: 100 concurrent same alert transitions through the REAL chain
 * (occurrence engine → 5-tuple allowlist → durable outbox → dispatcher →
 * scripted adapter) produce exactly one occurrence/record and at most one
 * external side effect per channel.
 *
 * SEC-06: the dispatcher's authorize dependency IS the B2 resolver here — a
 * consent withdrawal between durable commit and dispatch is caught at
 * dispatch time with zero provider calls.
 *
 * AT-11: administrative erasure through the REAL Identity coordinator
 * (reauthentication → fence-first → participant receipts) shreds every
 * registered NotificationCenter store including the B7 dispatch retry queue
 * and per-user quota ledger, the module receipt matches the coordinator's
 * public fence, and nothing regenerates afterwards.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceReference } from "@/shared/contracts/brands";
import type { SourceReference } from "@/shared/contracts/brands";

import { EmailChallengeService } from "../src/modules/identity/email-challenge";
import { FederatedSignInService, type FederatedConfig, type FederatedExchangeResult, type FederatedProvider } from "../src/modules/identity/federated";
import { IdentityService } from "../src/modules/identity/identity-service";
import { IdentitySessionStore } from "../src/modules/identity/session-store";
import type { MutationControl } from "../src/shared/contracts/mutation-control";
import { IdentityTestClock, SequenceEntropy } from "./harness/identity-harness";

import { createOccurrenceStore } from "../src/modules/notification-center/occurrence-engine";
import type { AlertObservation } from "../src/modules/notification-center/contracts";
import { planDeliveryIntent } from "../src/modules/notification-center/delivery-intent";
import type { PlannedDeliveryIntent } from "../src/modules/notification-center/delivery-intent";
import { DeliveryOutbox } from "../src/modules/notification-center/delivery-outbox";
import { DeliveryFactLog } from "../src/modules/notification-center/delivery-fact";
import { ProviderMessageDirectory, WebhookInbox, WebhookTombstoneRegistry } from "../src/modules/notification-center/webhook-inbox";
import { UnsubscribeTokenStore } from "../src/modules/notification-center/unsubscribe";
import { TokenBucket } from "../src/modules/notification-center/email-throttle";
import { DeliveryDispatcher, EmailQuotaLedger } from "../src/modules/notification-center/dispatch-loop";
import type { EmailSendResult } from "../src/modules/notification-center/dispatch-loop";
import { NotificationCenterErasure } from "../src/modules/notification-center/notification-erasure";
import { resolveFinancialDelivery } from "../src/modules/notification-center/delivery-authorization";
import type { FinancialDeliveryRecord, FinancialDeliveryState } from "../src/modules/notification-center/delivery-authorization";
import { presentInbox } from "../src/modules/notification-center/inbox-presenter";

const NOW_MS = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
const LATER_ISO = new Date(NOW_MS + 3_600_000).toISOString();
const TIMESTAMP = Math.floor(NOW_MS / 1000);
const ref = <N extends string>(value: string) => brandReference<string, N>(value);
const source: SourceReference = ref("source:evidence:int");

// Runtime-assembled scripted signing secret (never a credential-shaped literal in source).
const SECRET = `whsec_${Buffer.from("scripted-test-signing-key").toString("base64")}`;
function signFor(svixId: string, rawBody: string): string {
  const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${svixId}.${TIMESTAMP}.${rawBody}`).digest("base64")}`;
}

const FEDERATED_CONFIG: FederatedConfig = {
  publicOrigin: "https://app.test",
  google: { clientId: "gid", callbackPath: "/auth/callback/google", authorizationEndpoint: "https://accounts.google.test/authorize", issuer: "https://issuer.test", signingKey: "k" },
  github: { clientId: "ghid", callbackPath: "/auth/callback/github", authorizationEndpoint: "https://github.test/authorize" },
};

function buildIdentity(participants: ConstructorParameters<typeof IdentityService>[5]) {
  const clock = new IdentityTestClock();
  const store = new IdentitySessionStore(clock, new SequenceEntropy("s"));
  const challenge = new EmailChallengeService(store, clock, new SequenceEntropy("c"));
  const idle: Record<FederatedProvider, { exchange: () => Promise<FederatedExchangeResult> }> = {
    google: { exchange: async () => ({ kind: "untrusted", reason: "x" }) },
    github: { exchange: async () => ({ kind: "untrusted", reason: "x" }) },
  };
  const federated = new FederatedSignInService(store, clock, new SequenceEntropy("f"), FEDERATED_CONFIG, idle);
  const svc = new IdentityService(store, clock, new SequenceEntropy("i"), challenge, federated, participants);
  return { store, svc };
}

function control(idempotencyKey: string, expectedRevision: number): MutationControl {
  return { idempotencyKey, expectedRevision: String(expectedRevision) as unknown as MutationControl["expectedRevision"] };
}

function observation(rule: string, identity: number): AlertObservation {
  return {
    ruleReference: ref(rule),
    conditionRevision: "rev-1",
    conditionMet: true,
    sourceObservationIdentity: identity,
    asOf: NOW_ISO,
  };
}

function financialEmailIntent(causeId: string, subjectTag: string): PlannedDeliveryIntent {
  const outcome = planDeliveryIntent({
    cause: { kind: "alert_occurrence", causeId: ref(causeId) },
    channel: "email",
    source,
    actionMaterial: { kind: "unsubscribe", reference: ref("mat:unsub:int") },
    target: { kind: "workspace_financial_email", reference: ref(`dest:email:${subjectTag}`), destinationFingerprint: `fp:email:${subjectTag}` },
    binding: { templateRevision: "tpl-int-1", payloadHash: "hash-int", expiresAt: LATER_ISO },
  });
  if (outcome.status !== "planned") throw new Error(`integration intent rejected: ${outcome.reason}`);
  return outcome.intent;
}

function financialPushIntent(causeId: string, subjectTag: string): PlannedDeliveryIntent {
  const outcome = planDeliveryIntent({
    cause: { kind: "alert_occurrence", causeId: ref(causeId) },
    channel: "web_push",
    source,
    target: { kind: "workspace_web_push", reference: ref(`dest:push:${subjectTag}`), destinationFingerprint: `fp:push:${subjectTag}` },
    binding: { templateRevision: "tpl-int-1", payloadHash: "hash-int", expiresAt: LATER_ISO },
  });
  if (outcome.status !== "planned") throw new Error(`integration intent rejected: ${outcome.reason}`);
  return outcome.intent;
}

function financialAuthorization(workspace: string) {
  const record: FinancialDeliveryRecord = {
    deliveryReference: ref("fin:int:1"),
    workspaceReference: ref(workspace),
    channel: "email",
    target: ref("dest:int:1"),
    authorizationEpoch: ref("auth:5"),
    membershipRevision: ref("mem:3"),
    channelConsentEpoch: ref("consent:2"),
    endpointRevision: ref("addr:7"),
    authorizedEpoch: 10,
    expiresAt: LATER_ISO,
  };
  const state: { current: FinancialDeliveryState } = {
    current: {
      authorizationEpoch: ref("auth:5"),
      membershipRevision: ref("mem:3"),
      accountActive: true,
      channelConsentEpoch: ref("consent:2"),
      endpointRevision: ref("addr:7"),
      deletionFence: 0,
      now: NOW_ISO,
    },
  };
  return { record, state };
}

type Adapters = Readonly<{ emailResult?: EmailSendResult; pushCode?: number }>;

function deliveryWorld(workspace: string, adapters: Adapters = {}) {
  const outbox = new DeliveryOutbox();
  const facts = new DeliveryFactLog();
  const directory = new ProviderMessageDirectory();
  const quota = new EmailQuotaLedger();
  const emailCalls: PlannedDeliveryIntent[] = [];
  const pushCalls: PlannedDeliveryIntent[] = [];
  const { record, state } = financialAuthorization(workspace);
  let counter = 0;

  const dispatcher = new DeliveryDispatcher({
    outbox,
    facts,
    directory,
    // SEC-06: the REAL B2 resolver runs on every dispatch attempt.
    authorize: (_intent, nowMs) => {
      const outcome = resolveFinancialDelivery(record, { ...state.current, now: new Date(nowMs).toISOString() });
      return outcome.status === "resolved" ? { status: "authorized" } : { status: "rejected", reason: outcome.reason };
    },
    email: {
      adapter: {
        route: { provider: "resend", environment: "test" },
        send: ({ intent }) => {
          emailCalls.push(intent);
          counter += 1;
          return adapters.emailResult ?? { status: "accepted", providerMessageId: `pm:int:${counter}` };
        },
      },
      quota,
      health: () => ({ metrics: { sampleSize: 1000, hardBounces: 0, complaints: 0 }, manualApproval: false }),
      addressState: () => ({ hardBounced: false, reVerified: false, complained: false }),
      inQuietHours: () => false,
      bucket: new TokenBucket(1000, 1000, NOW_MS),
    },
    push: {
      send: ({ intent }) => {
        pushCalls.push(intent);
        return { kind: "status", code: adapters.pushCode ?? 201 };
      },
    },
  });

  return { outbox, facts, directory, quota, dispatcher, emailCalls, pushCalls, state };
}

describe("AT-10: 100 concurrent same transition, end to end", () => {
  it("yields one occurrence/record, allowed intents only, and at most one external call per channel", async () => {
    const WS = "workspace:at10";
    const store = createOccurrenceStore(() => NOW_ISO);
    store.registerRule({ ruleReference: ref("rule:at10"), workspaceReference: ref<"WorkspaceReference">(WS), conditionRevision: "rev-1" });

    const results = await Promise.all(Array.from({ length: 100 }, () => store.observe(observation("rule:at10", 1))));
    const transitions = results.filter((result) => result.kind === "transition");
    expect(transitions).toHaveLength(1);
    expect(store.listRecords(ref<"WorkspaceReference">(WS))).toHaveLength(1);

    const causeId = String(transitions[0]?.kind === "transition" ? transitions[0].record.causeId : "");
    const w = deliveryWorld(WS);
    const email = financialEmailIntent(causeId, "at10");
    const push = financialPushIntent(causeId, "at10");

    // A disallowed combination never becomes an intent (allowlist runs before the outbox).
    expect(planDeliveryIntent({
      cause: { kind: "alert_occurrence", causeId: ref(causeId) },
      channel: "email",
      source,
      target: { kind: "workspace_security_email", reference: ref("dest:sec"), destinationFingerprint: "fp:sec" },
      binding: { templateRevision: "tpl-int-1", payloadHash: "hash-int", expiresAt: LATER_ISO },
    }).status).toBe("rejected");

    // 100 concurrent replayed commits → exactly one committed row per intent.
    const commits = await Promise.all(Array.from({ length: 100 }, () => Promise.resolve(w.outbox.commit(WS, email, 1))));
    expect(commits.filter((commit) => commit.status === "committed")).toHaveLength(1);
    w.outbox.commit(WS, push, 1);

    // 100 concurrent dispatch ticks → at most one provider call per channel.
    await Promise.all(Array.from({ length: 100 }, () => w.dispatcher.dispatchTick(WS, NOW_MS)));
    expect(w.emailCalls).toHaveLength(1);
    expect(w.pushCalls).toHaveLength(1);
    expect(w.facts.listForDelivery(WS, email.uniqueKey).filter((fact) => fact.kind === "provider_accepted")).toHaveLength(1);
    expect(w.facts.listForDelivery(WS, push.uniqueKey).filter((fact) => fact.kind === "provider_accepted")).toHaveLength(1);
  });
});

describe("SEC-06: dispatch-time recheck through the real B2 resolver", () => {
  it("consent withdrawn between durable commit and dispatch → zero provider calls, suppressed fact", async () => {
    const WS = "workspace:sec06";
    const w = deliveryWorld(WS);
    const intent = financialEmailIntent("cause:alert:rule:sec06:1", "sec06");
    expect(w.outbox.commit(WS, intent, 1).status).toBe("committed");

    // The state changes AFTER the durable commit — only a dispatch-time recheck can catch it.
    w.state.current = { ...w.state.current, channelConsentEpoch: ref("consent:3") };
    await w.dispatcher.dispatchTick(WS, NOW_MS);
    expect(w.emailCalls).toHaveLength(0);
    expect(w.facts.listForDelivery(WS, intent.uniqueKey).map((fact) => fact.kind)).toContain("suppressed");
  });

  it("a stale-address record is rejected at dispatch even when it was valid at commit", async () => {
    const WS = "workspace:sec06b";
    const w = deliveryWorld(WS);
    const intent = financialEmailIntent("cause:alert:rule:sec06b:1", "sec06b");
    w.outbox.commit(WS, intent, 1);
    w.state.current = { ...w.state.current, endpointRevision: ref("addr:8") };
    await w.dispatcher.dispatchTick(WS, NOW_MS);
    expect(w.emailCalls).toHaveLength(0);
  });
});

describe("AT-11: administrative erasure through the real Identity coordinator", () => {
  async function erasedWorld() {
    const tombstones = new WebhookTombstoneRegistry([{ version: 1, key: "tombstone-key-v1" }], 1);
    const occurrences = createOccurrenceStore(() => NOW_ISO);
    const tokens = new UnsubscribeTokenStore();

    // The participant closes over the erasure module built AFTER identity hands
    // out the workspace reference (the coordinator wiring is constructor-fixed).
    let lateBound: NotificationCenterErasure | undefined;
    const participant = {
      erase: (context: Readonly<{ accountReference: string; workspaceReference: string; scope: "workspace" | "account"; fence: number }>) => {
        if (lateBound === undefined) throw new Error("erasure participant not wired");
        return lateBound.erase(context);
      },
    };
    const { store, svc } = buildIdentity([participant]);
    const account = store.ensureEmailAccount("erase-me@example.com");
    const subject = String(store.primaryWorkspace(account));

    // Email accepted (→ directory binding WITH route + quota counters), push 503
    // (→ live retry row in the dispatch queue at erasure time).
    const world = deliveryWorld(subject, { pushCode: 503 });
    const inbox = new WebhookInbox(world.directory, tombstones);
    const erasure = new NotificationCenterErasure({
      occurrences,
      stores: [
        { label: "delivery-intent-outbox", store: world.outbox },
        { label: "delivery-fact-log", store: world.facts },
        { label: "webhook-inbox", store: inbox },
        { label: "unsubscribe-token-hash", store: tokens },
        { label: "email-quota-usage", store: world.quota },
        { label: "dispatch-retry-queue", store: world.dispatcher },
      ],
      directory: world.directory,
      tombstones,
      now: () => NOW_MS,
    });
    lateBound = erasure;

    occurrences.registerRule({ ruleReference: ref("rule:at11"), workspaceReference: ref<"WorkspaceReference">(subject), conditionRevision: "rev-1" });
    const observed = await occurrences.observe(observation("rule:at11", 1));
    if (observed.kind !== "transition") throw new Error("expected transition");
    world.outbox.commit(subject, financialEmailIntent(String(observed.record.causeId), "at11"), 1);
    world.outbox.commit(subject, financialPushIntent("cause:alert:rule:at11:2", "at11-retry"), 1);
    await world.dispatcher.dispatchTick(subject, NOW_MS);
    if (world.emailCalls.length !== 1 || world.pushCalls.length !== 1) throw new Error("populate dispatch did not run");

    const token = tokens.issue({ workspace: subject, endpoint: "endpoint:int", topic: "topic:rule-at11", channel: "email", consentRevision: 1 }, NOW_MS, 1);
    if (token === undefined) throw new Error("expected token");

    return { store, svc, account, subject, occurrences, world, inbox, tokens, tombstones, erasure, token };
  }

  it("coordinator fence-first erasure: module receipt matches the public fence and every store line shreds", async () => {
    const w = await erasedWorld();
    const session = w.store.issueSession(w.account.accountReference, w.store.primaryWorkspace(w.account));
    const proof = w.svc.beginReauthentication(session.proof);
    if (proof === undefined) throw new Error("expected reauth proof");
    const revision = w.store.accountSecurityRevision(w.account.accountReference);
    const outcome = await w.svc.requestAdministrativeErasure({ scope: "account", confirmationProof: proof }, control("e-int", revision), session.proof);

    expect(outcome.status).toBe("accepted");
    if (outcome.status !== "accepted") throw new Error("unreachable");
    const receipt = w.erasure.receiptFor(w.subject);
    expect(receipt).toBeDefined();
    // Module receipt = the coordinator's public state (same fence, no invention).
    expect(String(receipt?.fence)).toBe(String(outcome.fence));
    const labels = receipt?.lines.map((line) => line.label) ?? [];
    expect(labels).toContain("email-quota-usage");
    expect(labels).toContain("dispatch-retry-queue");
    expect(receipt?.lines.find((line) => line.label === "email-quota-usage")?.shredded ?? 0).toBeGreaterThan(0);
    expect(receipt?.lines.find((line) => line.label === "dispatch-retry-queue")?.shredded ?? 0).toBeGreaterThan(0);
    expect(receipt?.tombstonedProviderMessages).toBeGreaterThanOrEqual(1);
    expect(receipt?.unroutedBindings).toBe(0);

    // The dispatch path is dead: no store rows, no provider calls on a late tick.
    const emailCallsBefore = w.world.emailCalls.length;
    await w.world.dispatcher.dispatchTick(w.subject, NOW_MS + 60_000);
    expect(w.world.emailCalls).toHaveLength(emailCallsBefore);
    expect(w.world.outbox.list(w.subject)).toHaveLength(0);
    expect(w.occurrences.listRecords(ref<"WorkspaceReference">(w.subject))).toHaveLength(0);
    expect(presentInbox(w.occurrences.listRecords(ref<"WorkspaceReference">(w.subject)), w.world.facts.list(w.subject)).cards).toHaveLength(0);

    // A late but correctly SIGNED provider webhook hits the erasure tombstone.
    const body = '{"type":"email.delivered","data":{"email_id":"pm:int:1"}}';
    const late = w.inbox.accept(
      { provider: "resend", environment: "test", svixId: "svix:int-late", timestampSeconds: TIMESTAMP, rawBody: body, signatureHeader: signFor("svix:int-late", body) },
      SECRET,
      NOW_MS,
      1,
    );
    expect(late).toEqual({ status: "suppressed", reason: "erasure_tombstone" });

    // Acknowledge, token consume and quota counters regenerate nothing.
    expect(w.occurrences.acknowledge(ref<"WorkspaceReference">(w.subject), ref("record:rule:at11:1"), "read")).toBe(false);
    expect(w.tokens.consume(w.token, NOW_MS)).toBeUndefined();
    w.world.quota.recordSend(w.subject, "financial", NOW_MS, 1);
    expect(w.world.quota.usage(w.subject, NOW_MS).userDay).toBe(0);

    // SEC-06 resolver also fails closed once the fence passes the authorized epoch.
    w.world.state.current = { ...w.world.state.current, deletionFence: Number(outcome.fence) + 100 };
    const resolveAfter = resolveFinancialDelivery(
      { ...financialAuthorization(w.subject).record, authorizedEpoch: 10 },
      w.world.state.current,
    );
    expect(resolveAfter).toEqual({ status: "rejected", reason: "deletion_fenced" });
  });

  it("erasure replay through the coordinator keeps the original receipt (idempotent public state)", async () => {
    const w = await erasedWorld();
    const session = w.store.issueSession(w.account.accountReference, w.store.primaryWorkspace(w.account));
    const proof = w.svc.beginReauthentication(session.proof);
    if (proof === undefined) throw new Error("expected reauth proof");
    const revision = w.store.accountSecurityRevision(w.account.accountReference);
    const first = await w.svc.requestAdministrativeErasure({ scope: "account", confirmationProof: proof }, control("e-replay", revision), session.proof);
    expect(first.status).toBe("accepted");
    const receipt = w.erasure.receiptFor(w.subject);

    // The idempotent coordinator replay returns the original outcome and the
    // participant receipt is untouched (never zeroed by a replayed sweep).
    const replay = await w.svc.requestAdministrativeErasure({ scope: "account", confirmationProof: proof }, control("e-replay", revision), session.proof);
    expect(replay).toEqual(first);
    expect(w.erasure.receiptFor(w.subject)).toEqual(receipt);
  });
});
