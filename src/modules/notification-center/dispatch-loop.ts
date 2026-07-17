import type { DeliveryOutbox } from "./delivery-outbox";
import type { DeliveryFactLog, DeliveryFactKind } from "./delivery-fact";
import { projectDeliveryStatus } from "./delivery-fact";
import type { PlannedDeliveryIntent } from "./delivery-intent";
import type { ProviderMessageDirectory, ProviderRoute } from "./webhook-inbox";
import { FencedKeyedStore } from "./fenced-store";
import { emailCircuitProbe, evaluateEmailCircuit, isEmailAddressBlocked } from "./email-circuit";
import type { EmailAddressState, EmailCircuitMetrics } from "./email-circuit";
import { reserveEmailQuota } from "./email-quota";
import type { EmailCategory, EmailQuotaUsage } from "./email-quota";
import { FINANCIAL_EMAIL_COOLDOWN_MS, financialCooldownActive, quietHoursHoldsFinancial } from "./email-throttle";
import type { TokenBucket } from "./email-throttle";
import { classifyPushOutcome } from "./push-transport";
import type { PushResponse } from "./push-transport";
import { nextRetry } from "./retry-schedule";
import type { RetryCategory } from "./retry-schedule";

/**
 * F5 worker dispatch loop (spec §11/§12, AT-10). An external provider is only
 * ever reached FROM here, AFTER the intent was durably committed to the outbox,
 * and AFTER a dispatch-time re-resolution of the Delivery Authorization Context
 * (SEC-06: the `authorize` dependency MUST be the B2 resolver — the dispatcher
 * never caches an authorization across ticks). The claim critical section is
 * synchronous, so concurrent ticks over the same intent produce at most one
 * external call, and every outcome lands as an append-only Delivery Fact.
 */

export type DispatchAuthorization =
  | Readonly<{ status: "authorized" }>
  | Readonly<{ status: "rejected"; reason: string }>;

export type DispatchAuthorizer = (intent: PlannedDeliveryIntent, nowMs: number) => DispatchAuthorization;

export type EmailSendResult =
  | Readonly<{ status: "accepted"; providerMessageId: string }>
  | Readonly<{ status: "rate_limited"; retryAfterSeconds?: number }>
  | Readonly<{ status: "provider_unavailable" }>
  | Readonly<{ status: "rejected_permanent" }>;

export type EmailDispatchAdapter = Readonly<{
  /** The provider route recorded on every message binding so erasure can tombstone it. */
  route: ProviderRoute;
  send: (input: Readonly<{ intent: PlannedDeliveryIntent; nowMs: number }>) => EmailSendResult | Promise<EmailSendResult>;
}>;

export type EmailChannelHealth = Readonly<{
  metrics: EmailCircuitMetrics;
  /** When the circuit opened; required for the 24h half-open probe. */
  openedAtMs?: number;
  manualApproval: boolean;
}>;

export type PushDispatchAdapter = Readonly<{
  send: (input: Readonly<{ intent: PlannedDeliveryIntent; nowMs: number }>) => PushResponse | Promise<PushResponse>;
  onSubscriptionInactive?: (destinationReference: string) => void;
}>;

type RetryRow = Readonly<{ sends: number; firstAtMs: number | undefined; nextAtMs: number }>;

function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function monthKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

function nextUtcMidnight(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

/**
 * Per-user email quota usage on the fenced substrate (the "per-user quota key"
 * of SEC-09): user counters are personal delivery state and shred behind the
 * fence, while provider-account totals are non-personal aggregates and survive.
 */
export class EmailQuotaLedger {
  readonly #user = new FencedKeyedStore<number>();
  readonly #global = new Map<string, number>();

  usage(subject: string, nowMs: number): EmailQuotaUsage {
    const day = dayKey(nowMs);
    const month = monthKey(nowMs);
    return {
      totalDay: this.#global.get(`t:d:${day}`) ?? 0,
      totalMonth: this.#global.get(`t:m:${month}`) ?? 0,
      financialDay: this.#global.get(`f:d:${day}`) ?? 0,
      financialMonth: this.#global.get(`f:m:${month}`) ?? 0,
      userDay: this.#user.get(subject, `d:${day}`) ?? 0,
      userMonth: this.#user.get(subject, `m:${month}`) ?? 0,
    };
  }

  recordSend(subject: string, category: EmailCategory, nowMs: number, atEpoch: number): void {
    const day = dayKey(nowMs);
    const month = monthKey(nowMs);
    if (category === "financial") {
      const written = this.#user.write(subject, `d:${day}`, (this.#user.get(subject, `d:${day}`) ?? 0) + 1, atEpoch);
      // Behind the deletion fence nothing is sent, so nothing is counted.
      if (!written) return;
      this.#user.write(subject, `m:${month}`, (this.#user.get(subject, `m:${month}`) ?? 0) + 1, atEpoch);
      this.#bump(`f:d:${day}`);
      this.#bump(`f:m:${month}`);
    }
    this.#bump(`t:d:${day}`);
    this.#bump(`t:m:${month}`);
  }

  eraseSubject(subject: string, fence: number): number {
    return this.#user.eraseSubject(subject, fence);
  }

  #bump(key: string): void {
    this.#global.set(key, (this.#global.get(key) ?? 0) + 1);
  }
}

export type DispatcherDependencies = Readonly<{
  outbox: DeliveryOutbox;
  facts: DeliveryFactLog;
  directory: ProviderMessageDirectory;
  /** SEC-06: must re-resolve the Delivery Authorization Context (B2 resolvers). */
  authorize: DispatchAuthorizer;
  email: Readonly<{
    adapter: EmailDispatchAdapter;
    quota: EmailQuotaLedger;
    health: (nowMs: number) => EmailChannelHealth;
    addressState: (destinationFingerprint: string) => EmailAddressState;
    inQuietHours: (nowMs: number) => boolean;
    bucket: TokenBucket;
  }>;
  push: PushDispatchAdapter;
  writeEpoch?: () => number;
}>;

// Statuses from which another send attempt is still allowed; everything else is
// dispatch-terminal (provider_accepted included — a later delivered/bounced comes
// from the webhook inbox, never from a re-send).
const DISPATCHABLE = new Set<DeliveryFactKind | "none">(["none", "queued", "delayed"]);

const QUIET_HOURS_REPOLL_MS = 30 * 60_000;

export class DeliveryDispatcher {
  readonly #retries = new FencedKeyedStore<RetryRow>();
  readonly #inFlight = new Set<string>();
  readonly #lastFinancialSend = new Map<string, number>();

  constructor(private readonly deps: DispatcherDependencies) {}

  async dispatchTick(subject: string, nowMs: number): Promise<void> {
    for (const intent of this.deps.outbox.list(subject)) {
      await this.#dispatchOne(subject, intent, nowMs);
    }
  }

  /** Shred per-subject dispatch state (retry queue, cooldown, in-flight claims). */
  eraseSubject(subject: string, fence: number): number {
    for (const key of [...this.#inFlight]) if (key.startsWith(`${subject}|`)) this.#inFlight.delete(key);
    for (const key of [...this.#lastFinancialSend.keys()]) if (key.startsWith(`${subject}|`)) this.#lastFinancialSend.delete(key);
    return this.#retries.eraseSubject(subject, fence);
  }

  async #dispatchOne(subject: string, intent: PlannedDeliveryIntent, nowMs: number): Promise<void> {
    const claimKey = `${subject}|${intent.uniqueKey}`;
    if (this.#inFlight.has(claimKey)) return;
    if (!DISPATCHABLE.has(projectDeliveryStatus(this.deps.facts.listForDelivery(subject, intent.uniqueKey)))) return;
    const row = this.#retries.get(subject, intent.uniqueKey);
    if (row !== undefined && nowMs < row.nextAtMs) return;

    const expiresAtMs = Date.parse(intent.binding.expiresAt);
    if (nowMs > expiresAtMs) {
      this.#appendFact(subject, intent, "expired", nowMs);
      return;
    }

    // SEC-06: fresh authorization on EVERY attempt, immediately before dispatch.
    if (this.deps.authorize(intent, nowMs).status === "rejected") {
      this.#appendFact(subject, intent, "suppressed", nowMs);
      return;
    }

    if (intent.channel === "email") await this.#dispatchEmail(subject, intent, nowMs, claimKey, expiresAtMs, row);
    else await this.#dispatchPush(subject, intent, nowMs, claimKey, expiresAtMs, row);
  }

  async #dispatchEmail(
    subject: string,
    intent: PlannedDeliveryIntent,
    nowMs: number,
    claimKey: string,
    expiresAtMs: number,
    row: RetryRow | undefined,
  ): Promise<void> {
    const { email } = this.deps;
    const category: EmailCategory = intent.variant === "financial_email" ? "financial" : "security";

    if (isEmailAddressBlocked(email.addressState(intent.target.destinationFingerprint))) {
      this.#appendFact(subject, intent, "suppressed", nowMs);
      return;
    }

    const health = email.health(nowMs);
    if (evaluateEmailCircuit(health.metrics).state === "open") {
      const probe = health.openedAtMs === undefined ? "open" : emailCircuitProbe(health.openedAtMs, nowMs, health.manualApproval);
      if (probe === "open") {
        // Financial email is optional traffic — never queue it against sender
        // reputation. Security email waits for the half-open probe window.
        if (category === "financial") this.#appendFact(subject, intent, "suppressed", nowMs);
        else this.#hold(subject, intent, nowMs, nowMs + QUIET_HOURS_REPOLL_MS, row);
        return;
      }
    }

    // Quota is reserved once per message (first attempt), not per retry — a
    // flaky provider must not burn the 5/day user cap on a single delivery.
    const alreadyReserved = (row?.sends ?? 0) > 0;
    if (!alreadyReserved) {
      const reservation = reserveEmailQuota(category, email.quota.usage(subject, nowMs));
      if (!reservation.granted) {
        if (reservation.reason === "monthly_quota" || reservation.reason === "user_monthly") {
          this.#appendFact(subject, intent, "suppressed", nowMs);
        } else {
          this.#hold(subject, intent, nowMs, nextUtcMidnight(nowMs), row);
        }
        return;
      }
    }

    if (quietHoursHoldsFinancial(category, email.inQuietHours(nowMs))) {
      this.#hold(subject, intent, nowMs, nowMs + QUIET_HOURS_REPOLL_MS, row);
      return;
    }

    const cooldownKey = `${subject}|${this.#ruleOf(intent)}`;
    if (category === "financial") {
      const lastSentAtMs = this.#lastFinancialSend.get(cooldownKey);
      if (financialCooldownActive(lastSentAtMs, nowMs)) {
        this.#hold(subject, intent, nowMs, (lastSentAtMs ?? nowMs) + FINANCIAL_EMAIL_COOLDOWN_MS, row);
        return;
      }
    }

    // Transient pacing: stay eligible, retry next tick, no fact and no attempt burned.
    if (!email.bucket.tryTake(nowMs)) return;

    const sends = row?.sends ?? 0;
    const firstAtMs = row?.firstAtMs ?? nowMs;
    this.#inFlight.add(claimKey);
    try {
      if (this.deps.facts.listForDelivery(subject, intent.uniqueKey).length === 0) {
        this.#appendFact(subject, intent, "queued", nowMs);
      }
      if (!alreadyReserved) email.quota.recordSend(subject, category, nowMs, this.#epoch());
      let result: EmailSendResult;
      try {
        result = await email.adapter.send({ intent, nowMs });
      } catch {
        result = { status: "provider_unavailable" };
      }
      if (result.status === "accepted") {
        this.#appendFact(subject, intent, "provider_accepted", nowMs);
        this.deps.directory.bind(
          result.providerMessageId,
          {
            owner: subject,
            ownerKind: intent.variant === "pending_account_challenge" ? "pending_identity" : "workspace",
            recipientFingerprint: intent.target.destinationFingerprint,
            templateRevision: intent.binding.templateRevision,
          },
          email.adapter.route,
        );
        if (category === "financial") this.#lastFinancialSend.set(cooldownKey, nowMs);
        return;
      }
      if (result.status === "rejected_permanent") {
        this.#appendFact(subject, intent, "failed", nowMs);
        return;
      }
      const notBeforeMs = result.status === "rate_limited" && result.retryAfterSeconds !== undefined
        ? nowMs + result.retryAfterSeconds * 1000
        : undefined;
      this.#scheduleRetry(subject, intent, nowMs, sends + 1, firstAtMs, expiresAtMs, notBeforeMs);
    } finally {
      this.#inFlight.delete(claimKey);
    }
  }

  async #dispatchPush(
    subject: string,
    intent: PlannedDeliveryIntent,
    nowMs: number,
    claimKey: string,
    expiresAtMs: number,
    row: RetryRow | undefined,
  ): Promise<void> {
    const sends = row?.sends ?? 0;
    const firstAtMs = row?.firstAtMs ?? nowMs;
    this.#inFlight.add(claimKey);
    try {
      if (this.deps.facts.listForDelivery(subject, intent.uniqueKey).length === 0) {
        this.#appendFact(subject, intent, "queued", nowMs);
      }
      let response: PushResponse;
      try {
        response = await this.deps.push.send({ intent, nowMs });
      } catch {
        response = { kind: "network_error" };
      }
      const outcome = classifyPushOutcome(response);
      switch (outcome.kind) {
        case "accepted":
        case "accepted_unconfirmed":
          this.#appendFact(subject, intent, "provider_accepted", nowMs);
          return;
        case "subscription_inactive":
          this.#appendFact(subject, intent, "provider_suppressed", nowMs);
          this.deps.push.onSubscriptionInactive?.(String(intent.target.reference));
          return;
        case "permanent_failure":
        case "circuit_open":
          this.#appendFact(subject, intent, "failed", nowMs);
          return;
        case "rate_limited":
        case "retry":
          this.#scheduleRetry(subject, intent, nowMs, sends + 1, firstAtMs, expiresAtMs, undefined);
          return;
      }
    } finally {
      this.#inFlight.delete(claimKey);
    }
  }

  #scheduleRetry(
    subject: string,
    intent: PlannedDeliveryIntent,
    nowMs: number,
    sends: number,
    firstAtMs: number,
    expiresAtMs: number,
    notBeforeMs: number | undefined,
  ): void {
    const category: RetryCategory = intent.variant === "financial_email" || intent.variant === "financial_web_push"
      ? "financial"
      : "account";
    const decision = nextRetry(category, sends, firstAtMs, expiresAtMs, notBeforeMs);
    if (decision.action === "stop") {
      this.#appendFact(subject, intent, decision.reason === "deadline" ? "expired" : "failed", nowMs);
      return;
    }
    this.#retries.write(subject, intent.uniqueKey, { sends, firstAtMs, nextAtMs: decision.atMs }, this.#epoch());
    this.#appendDelayedOnce(subject, intent, nowMs);
  }

  /** A gate hold: keep the attempt count, move the next poll, record one delayed fact. */
  #hold(subject: string, intent: PlannedDeliveryIntent, nowMs: number, nextAtMs: number, row: RetryRow | undefined): void {
    this.#retries.write(subject, intent.uniqueKey, { sends: row?.sends ?? 0, firstAtMs: row?.firstAtMs, nextAtMs }, this.#epoch());
    this.#appendDelayedOnce(subject, intent, nowMs);
  }

  #appendDelayedOnce(subject: string, intent: PlannedDeliveryIntent, nowMs: number): void {
    const existing = this.deps.facts.listForDelivery(subject, intent.uniqueKey);
    if (existing[existing.length - 1]?.kind !== "delayed") this.#appendFact(subject, intent, "delayed", nowMs);
  }

  #appendFact(subject: string, intent: PlannedDeliveryIntent, kind: DeliveryFactKind, nowMs: number): void {
    this.deps.facts.append(
      subject,
      { causeId: intent.cause.causeId, intentUniqueKey: intent.uniqueKey, kind, occurredAt: new Date(nowMs).toISOString() },
      this.#epoch(),
    );
  }

  #ruleOf(intent: PlannedDeliveryIntent): string {
    // Alert cause ids are `cause:alert:{rule}:{seq}`; the 30-minute financial
    // cooldown is per rule, so replays of the same rule pace together.
    const parts = String(intent.cause.causeId).split(":");
    return intent.cause.kind === "alert_occurrence" && parts.length >= 3 ? (parts[2] ?? "") : String(intent.cause.causeId);
  }

  #epoch(): number {
    return this.deps.writeEpoch?.() ?? 1;
  }
}
