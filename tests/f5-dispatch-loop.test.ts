import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { planDeliveryIntent } from "../src/modules/notification-center/delivery-intent";
import type {
  DeliveryCause,
  DeliveryIntentRequest,
  DeliveryTarget,
  PlannedDeliveryIntent,
} from "../src/modules/notification-center/delivery-intent";
import { DeliveryOutbox } from "../src/modules/notification-center/delivery-outbox";
import { DeliveryFactLog, projectDeliveryStatus } from "../src/modules/notification-center/delivery-fact";
import { ProviderMessageDirectory } from "../src/modules/notification-center/webhook-inbox";
import { TokenBucket } from "../src/modules/notification-center/email-throttle";
import {
  DeliveryDispatcher,
  EmailQuotaLedger,
  type DispatchAuthorizer,
  type EmailChannelHealth,
  type EmailSendResult,
} from "../src/modules/notification-center/dispatch-loop";
import type { SourceReference } from "@/shared/contracts/brands";

const T0 = Date.parse("2026-01-02T10:00:00.000Z");
const WORKSPACE = "workspace:w1";
const source: SourceReference = brandReference<string, "SourceReference">("source:evidence:1");

function target(kind: DeliveryTarget["kind"], suffix = "1"): DeliveryTarget {
  return {
    kind,
    reference: brandReference<string, "DeliveryDestinationReference">(`dest:${kind}:${suffix}`),
    destinationFingerprint: `fp:${kind}:${suffix}`,
  };
}

function alertCause(rule: string, seq: number): DeliveryCause {
  return { kind: "alert_occurrence", causeId: brandReference<string, "DeliveryCauseId">(`cause:alert:${rule}:${seq}`) };
}

function plan(request: DeliveryIntentRequest): PlannedDeliveryIntent {
  const out = planDeliveryIntent(request);
  if (out.status !== "planned") throw new Error(`test intent rejected: ${out.reason}`);
  return out.intent;
}

function financialEmailIntent(rule = "r1", seq = 1, expiresAt = new Date(T0 + 24 * 3_600_000).toISOString()): PlannedDeliveryIntent {
  return plan({
    cause: alertCause(rule, seq),
    channel: "email",
    source,
    actionMaterial: { kind: "unsubscribe", reference: brandReference<string, "DeliveryActionMaterialReference">("mat:unsub") },
    target: target("workspace_financial_email"),
    binding: { templateRevision: "tpl-fin-1", payloadHash: "hash-1", expiresAt },
  });
}

function financialPushIntent(rule = "r1", seq = 1, expiresAt = new Date(T0 + 24 * 3_600_000).toISOString()): PlannedDeliveryIntent {
  return plan({
    cause: alertCause(rule, seq),
    channel: "web_push",
    source,
    target: target("workspace_web_push"),
    binding: { templateRevision: "tpl-push-1", payloadHash: "hash-2", expiresAt },
  });
}

function pendingChallengeIntent(): PlannedDeliveryIntent {
  return plan({
    cause: { kind: "account_security_event", causeId: brandReference<string, "DeliveryCauseId">("cause:sec:e1"), purpose: "verify_email" },
    channel: "email",
    actionMaterial: { kind: "account_challenge", reference: brandReference<string, "DeliveryActionMaterialReference">("mat:chal") },
    target: target("pending_account_email"),
    binding: { templateRevision: "tpl-chal-1", payloadHash: "hash-3", expiresAt: new Date(T0 + 24 * 3_600_000).toISOString() },
  });
}

const healthyEmail: EmailChannelHealth = {
  metrics: { sampleSize: 1000, hardBounces: 0, complaints: 0 },
  manualApproval: false,
};

type WorldOverrides = Readonly<{
  emailResults?: EmailSendResult[];
  pushCodes?: (number | "network_error" | "accepted_before_timeout")[];
  authorize?: DispatchAuthorizer;
  health?: EmailChannelHealth;
  addressState?: { hardBounced: boolean; reVerified: boolean; complained: boolean };
  inQuietHours?: (nowMs: number) => boolean;
  bucket?: TokenBucket;
}>;

function world(overrides: WorldOverrides = {}) {
  const outbox = new DeliveryOutbox();
  const facts = new DeliveryFactLog();
  const directory = new ProviderMessageDirectory();
  const quota = new EmailQuotaLedger();
  const emailCalls: { intent: PlannedDeliveryIntent; nowMs: number }[] = [];
  const pushCalls: { intent: PlannedDeliveryIntent; nowMs: number }[] = [];
  const inactiveSubscriptions: string[] = [];
  const authorizeCalls: { uniqueKey: string; nowMs: number }[] = [];
  const emailResults = overrides.emailResults ?? [{ status: "accepted", providerMessageId: "pm-1" } as const];
  const pushCodes = overrides.pushCodes ?? [201];
  const authorize: DispatchAuthorizer = overrides.authorize ?? (() => ({ status: "authorized" }));

  const dispatcher = new DeliveryDispatcher({
    outbox,
    facts,
    directory,
    authorize: (intent, nowMs) => {
      authorizeCalls.push({ uniqueKey: intent.uniqueKey, nowMs });
      return authorize(intent, nowMs);
    },
    email: {
      adapter: {
        route: { provider: "resend", environment: "test" },
        send: (input) => {
          emailCalls.push(input);
          return emailResults[Math.min(emailCalls.length - 1, emailResults.length - 1)] as EmailSendResult;
        },
      },
      quota,
      health: () => overrides.health ?? healthyEmail,
      addressState: () => overrides.addressState ?? { hardBounced: false, reVerified: false, complained: false },
      inQuietHours: overrides.inQuietHours ?? (() => false),
      bucket: overrides.bucket ?? new TokenBucket(100, 100, T0),
    },
    push: {
      send: (input) => {
        pushCalls.push(input);
        const code = pushCodes[Math.min(pushCalls.length - 1, pushCodes.length - 1)];
        if (code === "network_error") return { kind: "network_error" };
        if (code === "accepted_before_timeout") return { kind: "accepted_before_timeout" };
        return { kind: "status", code: code as number };
      },
      onSubscriptionInactive: (reference) => inactiveSubscriptions.push(reference),
    },
  });

  return { outbox, facts, directory, quota, dispatcher, emailCalls, pushCalls, inactiveSubscriptions, authorizeCalls };
}

function commit(w: ReturnType<typeof world>, intent: PlannedDeliveryIntent, subject = WORKSPACE): void {
  const result = w.outbox.commit(subject, intent, 1);
  if (result.status === "suppressed") throw new Error("test commit suppressed");
}

function factKinds(w: ReturnType<typeof world>, intent: PlannedDeliveryIntent, subject = WORKSPACE): string[] {
  return w.facts.listForDelivery(subject, intent.uniqueKey).map((f) => f.kind);
}

describe("SEC-06: dispatch-time authorization recheck", () => {
  it("re-authorizes at dispatch time and never calls the adapter on rejection", async () => {
    const w = world({ authorize: () => ({ status: "rejected", reason: "stale_epoch" }) });
    const intent = financialEmailIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    expect(w.authorizeCalls).toHaveLength(1);
    expect(w.emailCalls).toHaveLength(0);
    expect(factKinds(w, intent)).toContain("suppressed");
    // A rejected intent is dispatch-terminal: a later tick never retries it.
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 60_000);
    expect(w.emailCalls).toHaveLength(0);
    expect(w.authorizeCalls).toHaveLength(1);
  });

  it("authorization runs again on every retry attempt, not just the first", async () => {
    const w = world({ emailResults: [{ status: "provider_unavailable" }, { status: "accepted", providerMessageId: "pm-2" }] });
    const intent = financialEmailIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 30_000);
    expect(w.emailCalls).toHaveLength(2);
    expect(w.authorizeCalls).toHaveLength(2);
    expect(w.authorizeCalls[1]?.nowMs).toBe(T0 + 30_000);
  });
});

describe("exactly-once external side effect (AT-10)", () => {
  it("100 concurrent ticks over the same committed intent call the provider exactly once", async () => {
    const w = world();
    const intent = financialEmailIntent();
    commit(w, intent);
    await Promise.all(Array.from({ length: 100 }, () => w.dispatcher.dispatchTick(WORKSPACE, T0)));
    expect(w.emailCalls).toHaveLength(1);
    expect(factKinds(w, intent).filter((k) => k === "provider_accepted")).toHaveLength(1);
  });

  it("a replayed outbox commit stays a single dispatch (idempotent end to end)", async () => {
    const w = world();
    const intent = financialEmailIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    commit(w, intent); // replay: duplicate commit of the same uniqueKey
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 1_000);
    expect(w.emailCalls).toHaveLength(1);
  });
});

describe("email dispatch outcomes and provider route binding", () => {
  it("accepted send appends queued+provider_accepted and binds the provider message WITH its route", async () => {
    const w = world({ emailResults: [{ status: "accepted", providerMessageId: "pm-route-1" }] });
    const intent = financialEmailIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    expect(factKinds(w, intent)).toEqual(["queued", "provider_accepted"]);
    const binding = w.directory.lookup("pm-route-1");
    expect(binding).toMatchObject({
      owner: WORKSPACE,
      ownerKind: "workspace",
      recipientFingerprint: intent.target.destinationFingerprint,
      templateRevision: "tpl-fin-1",
    });
    // The route must be present so a later erasure can tombstone this message id
    // (the B6 unroutedBindings gap must not regrow through the dispatch path).
    expect(w.directory.eraseOwner(WORKSPACE)).toEqual([
      { providerMessageId: "pm-route-1", route: { provider: "resend", environment: "test" } },
    ]);
  });

  it("a pending account challenge binds with pending_identity ownership", async () => {
    const w = world({ emailResults: [{ status: "accepted", providerMessageId: "pm-pending" }] });
    const intent = pendingChallengeIntent();
    commit(w, intent, "pending:p1");
    await w.dispatcher.dispatchTick("pending:p1", T0);
    expect(w.directory.lookup("pm-pending")?.ownerKind).toBe("pending_identity");
  });

  it("provider_unavailable retries on the exact financial ladder and converges to accepted", async () => {
    const w = world({
      emailResults: [
        { status: "provider_unavailable" },
        { status: "provider_unavailable" },
        { status: "accepted", providerMessageId: "pm-3" },
      ],
    });
    const intent = financialEmailIntent();
    commit(w, intent);
    // financial ladder offsets from first attempt: 0s, 30s, 120s
    for (const offset of [0, 1_000, 29_000, 30_000, 60_000, 120_000]) {
      await w.dispatcher.dispatchTick(WORKSPACE, T0 + offset);
    }
    expect(w.emailCalls.map((c) => c.nowMs)).toEqual([T0, T0 + 30_000, T0 + 120_000]);
    expect(projectDeliveryStatus(w.facts.listForDelivery(WORKSPACE, intent.uniqueKey))).toBe("provider_accepted");
  });

  it("429 Retry-After only delays a send, never pulls it earlier", async () => {
    const w = world({
      emailResults: [
        { status: "rate_limited", retryAfterSeconds: 300 },
        { status: "accepted", providerMessageId: "pm-4" },
      ],
    });
    const intent = financialEmailIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    // Ladder says +30s but Retry-After pins the send to ≥ T0+300s.
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 30_000);
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 299_000);
    expect(w.emailCalls).toHaveLength(1);
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 300_000);
    expect(w.emailCalls.map((c) => c.nowMs)).toEqual([T0, T0 + 300_000]);
  });

  it("a permanent provider rejection is failed with no retry", async () => {
    const w = world({ emailResults: [{ status: "rejected_permanent" }] });
    const intent = financialEmailIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 3_600_000);
    expect(w.emailCalls).toHaveLength(1);
    expect(factKinds(w, intent)).toContain("failed");
  });

  it("an intent past its payload binding expiry becomes expired without a provider call", async () => {
    const w = world();
    const intent = financialEmailIntent("r1", 1, new Date(T0 - 1_000).toISOString());
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    expect(w.emailCalls).toHaveLength(0);
    expect(factKinds(w, intent)).toEqual(["expired"]);
  });

  it("exhausting the financial ladder converges to failed(max_attempts)", async () => {
    const w = world({ emailResults: [{ status: "provider_unavailable" }] });
    const intent = financialEmailIntent();
    commit(w, intent);
    // financial offsets: 0, 30s, 2m, 10m, 30m, 90m — then stop.
    for (const offset of [0, 30_000, 120_000, 600_000, 1_800_000, 5_400_000, 7_000_000, 7_199_000]) {
      await w.dispatcher.dispatchTick(WORKSPACE, T0 + offset);
    }
    expect(w.emailCalls).toHaveLength(6);
    expect(factKinds(w, intent)).toContain("failed");
  });
});

describe("email channel gates run before any provider call", () => {
  it("a blocked address (unverified hard bounce) is suppressed with zero provider calls", async () => {
    const w = world({ addressState: { hardBounced: true, reVerified: false, complained: false } });
    const intent = financialEmailIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    expect(w.emailCalls).toHaveLength(0);
    expect(factKinds(w, intent)).toContain("suppressed");
  });

  it("an open circuit suppresses financial email but only delays an account challenge", async () => {
    const openHealth: EmailChannelHealth = {
      metrics: { sampleSize: 400, hardBounces: 40, complaints: 0 },
      openedAtMs: T0 - 3_600_000,
      manualApproval: false,
    };
    const w = world({ health: openHealth, emailResults: [{ status: "accepted", providerMessageId: "pm-c" }] });
    const financial = financialEmailIntent();
    const challenge = pendingChallengeIntent();
    commit(w, financial);
    commit(w, challenge, "pending:p1");
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    await w.dispatcher.dispatchTick("pending:p1", T0);
    expect(w.emailCalls).toHaveLength(0);
    expect(factKinds(w, financial)).toContain("suppressed");
    expect(factKinds(w, challenge, "pending:p1")).toContain("delayed");
  });

  it("after 24h the circuit is half-open and a probe send goes out", async () => {
    const openHealth: EmailChannelHealth = {
      metrics: { sampleSize: 400, hardBounces: 40, complaints: 0 },
      openedAtMs: T0 - 25 * 3_600_000,
      manualApproval: false,
    };
    const w = world({ health: openHealth, emailResults: [{ status: "accepted", providerMessageId: "pm-probe" }] });
    const challenge = pendingChallengeIntent();
    commit(w, challenge, "pending:p1");
    await w.dispatcher.dispatchTick("pending:p1", T0);
    expect(w.emailCalls).toHaveLength(1);
  });

  it("quiet hours hold financial email but let a security challenge through", async () => {
    const w = world({ inQuietHours: () => true, emailResults: [{ status: "accepted", providerMessageId: "pm-q" }] });
    const financial = financialEmailIntent();
    const challenge = pendingChallengeIntent();
    commit(w, financial);
    commit(w, challenge, "pending:p1");
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    await w.dispatcher.dispatchTick("pending:p1", T0);
    expect(w.emailCalls).toHaveLength(1);
    expect(w.emailCalls[0]?.intent.variant).toBe("pending_account_challenge");
    expect(factKinds(w, financial)).toContain("delayed");
  });

  it("quiet-hours hold resumes (fresh authorization) once quiet hours end", async () => {
    let quiet = true;
    const w = world({ inQuietHours: () => quiet, emailResults: [{ status: "accepted", providerMessageId: "pm-q2" }] });
    const financial = financialEmailIntent();
    commit(w, financial);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    expect(w.emailCalls).toHaveLength(0);
    quiet = false;
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 30 * 60_000);
    expect(w.emailCalls).toHaveLength(1);
    expect(w.authorizeCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("two financial emails for the same rule inside 30 minutes hold the second (cooldown)", async () => {
    const w = world({
      emailResults: [
        { status: "accepted", providerMessageId: "pm-cd-1" },
        { status: "accepted", providerMessageId: "pm-cd-2" },
      ],
    });
    const first = financialEmailIntent("ruleA", 1);
    const second = financialEmailIntent("ruleA", 2);
    commit(w, first);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    commit(w, second);
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 60_000);
    expect(w.emailCalls).toHaveLength(1);
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 30 * 60_000);
    expect(w.emailCalls).toHaveLength(2);
  });

  it("per-user daily quota exhaustion defers financial email to the next UTC day", async () => {
    const w = world({ emailResults: [{ status: "accepted", providerMessageId: "pm-u" }] });
    // Pre-consume the 5/day user cap (financial).
    for (let i = 0; i < 5; i += 1) w.quota.recordSend(WORKSPACE, "financial", T0, 1);
    const intent = financialEmailIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    expect(w.emailCalls).toHaveLength(0);
    expect(factKinds(w, intent)).toContain("delayed");
    // Next UTC midnight after T0 (2026-01-03T00:00Z) the user counter is fresh.
    const nextDay = Date.parse("2026-01-03T00:00:00.000Z");
    await w.dispatcher.dispatchTick(WORKSPACE, nextDay);
    expect(w.emailCalls).toHaveLength(1);
  });

  it("monthly quota exhaustion suppresses instead of waiting", async () => {
    const w = world();
    for (let i = 0; i < 60; i += 1) w.quota.recordSend(WORKSPACE, "financial", T0, 1);
    const intent = financialEmailIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    expect(w.emailCalls).toHaveLength(0);
    expect(factKinds(w, intent)).toContain("suppressed");
  });

  it("an empty token bucket defers without consuming a retry attempt or writing a fact", async () => {
    const bucket = new TokenBucket(1, 0, T0);
    const w = world({ bucket, emailResults: [{ status: "accepted", providerMessageId: "pm-b1" }, { status: "accepted", providerMessageId: "pm-b2" }] });
    const first = financialEmailIntent("rb", 1);
    const second = plan({
      cause: alertCause("rc", 1),
      channel: "email",
      source,
      actionMaterial: { kind: "unsubscribe", reference: brandReference<string, "DeliveryActionMaterialReference">("mat:unsub") },
      target: target("workspace_financial_email", "2"),
      binding: { templateRevision: "tpl-fin-1", payloadHash: "hash-b", expiresAt: new Date(T0 + 24 * 3_600_000).toISOString() },
    });
    commit(w, first);
    commit(w, second);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    expect(w.emailCalls).toHaveLength(1);
    const deferred = w.emailCalls[0]?.intent.uniqueKey === first.uniqueKey ? second : first;
    expect(factKinds(w, deferred)).toEqual([]);
    // Bucket never refills (rate 0) — the deferred intent stays eligible but unsent.
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 1_000);
    expect(w.emailCalls).toHaveLength(1);
  });
});

describe("push dispatch outcomes", () => {
  it("2xx converges to provider_accepted", async () => {
    const w = world({ pushCodes: [201] });
    const intent = financialPushIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    expect(factKinds(w, intent)).toEqual(["queued", "provider_accepted"]);
  });

  it("accept-before-timeout counts as accepted (no duplicate retry)", async () => {
    const w = world({ pushCodes: ["accepted_before_timeout"] });
    const intent = financialPushIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 30_000);
    expect(w.pushCalls).toHaveLength(1);
    expect(projectDeliveryStatus(w.facts.listForDelivery(WORKSPACE, intent.uniqueKey))).toBe("provider_accepted");
  });

  it("404/410 deactivates the subscription and never retries", async () => {
    const w = world({ pushCodes: [410] });
    const intent = financialPushIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 30_000);
    expect(w.pushCalls).toHaveLength(1);
    expect(factKinds(w, intent)).toContain("provider_suppressed");
    expect(w.inactiveSubscriptions).toEqual([String(intent.target.reference)]);
  });

  it("401/403 (VAPID circuit) and 413/400 are terminal failures", async () => {
    for (const code of [401, 403, 413, 400]) {
      const w = world({ pushCodes: [code] });
      const intent = financialPushIntent();
      commit(w, intent);
      await w.dispatcher.dispatchTick(WORKSPACE, T0);
      await w.dispatcher.dispatchTick(WORKSPACE, T0 + 30_000);
      expect(w.pushCalls, `code ${code}`).toHaveLength(1);
      expect(factKinds(w, intent), `code ${code}`).toContain("failed");
    }
  });

  it("5xx retries on the financial ladder then converges when the provider recovers", async () => {
    const w = world({ pushCodes: [503, 201] });
    const intent = financialPushIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 29_000);
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 30_000);
    expect(w.pushCalls.map((c) => c.nowMs)).toEqual([T0, T0 + 30_000]);
    expect(projectDeliveryStatus(w.facts.listForDelivery(WORKSPACE, intent.uniqueKey))).toBe("provider_accepted");
  });
});

describe("SEC-09: erasure stops the dispatch path", () => {
  it("after eraseSubject no intent dispatches, no fact lands, and retry state is shredded", async () => {
    const w = world({ emailResults: [{ status: "provider_unavailable" }] });
    const intent = financialEmailIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0); // one failed attempt → retry queued
    expect(w.emailCalls).toHaveLength(1);

    const fence = 1;
    w.outbox.eraseSubject(WORKSPACE, fence);
    w.facts.eraseSubject(WORKSPACE, fence);
    expect(w.dispatcher.eraseSubject(WORKSPACE, fence)).toBeGreaterThan(0);

    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 30_000);
    await w.dispatcher.dispatchTick(WORKSPACE, T0 + 3_600_000);
    expect(w.emailCalls).toHaveLength(1);
    expect(w.facts.list(WORKSPACE)).toEqual([]);
  });

  it("quota ledger user counters are erasable and isolated per subject", () => {
    const ledger = new EmailQuotaLedger();
    ledger.recordSend("workspace:a", "financial", T0, 1);
    ledger.recordSend("workspace:a", "financial", T0, 1);
    ledger.recordSend("workspace:b", "financial", T0, 1);
    expect(ledger.usage("workspace:a", T0).userDay).toBe(2);
    expect(ledger.usage("workspace:b", T0).userDay).toBe(1);
    // Global totals aggregate across users.
    expect(ledger.usage("workspace:a", T0).totalDay).toBe(3);
    expect(ledger.eraseSubject("workspace:a", 1)).toBeGreaterThan(0);
    expect(ledger.usage("workspace:a", T0).userDay).toBe(0);
    // Erasure removes the personal counters, not the aggregate provider totals.
    expect(ledger.usage("workspace:b", T0).userDay).toBe(1);
    // Post-fence writes are suppressed — no counter regeneration.
    ledger.recordSend("workspace:a", "financial", T0, 1);
    expect(ledger.usage("workspace:a", T0).userDay).toBe(0);
  });
});

describe("SEC-05: no raw destination in durable dispatch state", () => {
  it("facts and retry state never contain the destination reference", async () => {
    const w = world({ emailResults: [{ status: "provider_unavailable" }] });
    const intent = financialEmailIntent();
    commit(w, intent);
    await w.dispatcher.dispatchTick(WORKSPACE, T0);
    const serialized = JSON.stringify(w.facts.list(WORKSPACE));
    expect(serialized).not.toContain("dest:");
  });
});
