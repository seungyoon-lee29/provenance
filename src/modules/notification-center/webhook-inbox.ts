import { createHmac } from "node:crypto";

import type { DeliveryFactKind } from "./delivery-fact";
import { FencedKeyedStore } from "./fenced-store";
import { verifyWebhookSignature } from "./webhook-signature";

/**
 * F5 durable webhook inbox (spec §12 lines 343–344).
 *
 * A verified webhook is deduped on `(provider, environment, svix-id)` and its
 * Fact is bound to the SERVER-stored owner of the provider message id — the
 * workspace or pending identity, recipient fingerprint and template revision
 * recorded at dispatch time. Nothing the webhook itself claims (owner, address)
 * is trusted or stored. Before any raw storage the provider message id is
 * checked against the erasure tombstone registry so a late webhook for an
 * erased account writes nothing but a bounded counter.
 */
export type WebhookOwnerKind = "workspace" | "pending_identity";

export type WebhookOwnerBinding = Readonly<{
  owner: string;
  ownerKind: WebhookOwnerKind;
  recipientFingerprint: string;
  templateRevision: string;
}>;

export type ProviderRoute = Readonly<{ provider: string; environment: string }>;

/** Server-side dispatch record: provider message id → owner binding. */
export class ProviderMessageDirectory {
  readonly #bindings = new Map<string, Readonly<{ binding: WebhookOwnerBinding; route?: ProviderRoute }>>();

  /** `route` is where the message was dispatched; erasure needs it to tombstone the id (SEC-09). */
  bind(providerMessageId: string, binding: WebhookOwnerBinding, route?: ProviderRoute): void {
    this.#bindings.set(providerMessageId, { binding, ...(route === undefined ? {} : { route }) });
  }

  lookup(providerMessageId: string): WebhookOwnerBinding | undefined {
    return this.#bindings.get(providerMessageId)?.binding;
  }

  erase(providerMessageId: string): void {
    this.#bindings.delete(providerMessageId);
  }

  /** Remove every binding owned by `owner` and return the removed ids for tombstoning. */
  eraseOwner(owner: string): readonly Readonly<{ providerMessageId: string; route?: ProviderRoute }>[] {
    const removed: Readonly<{ providerMessageId: string; route?: ProviderRoute }>[] = [];
    for (const [id, entry] of this.#bindings) {
      if (entry.binding.owner !== owner) continue;
      removed.push({ providerMessageId: id, ...(entry.route === undefined ? {} : { route: entry.route }) });
      this.#bindings.delete(id);
    }
    return removed;
  }
}

const TOMBSTONE_DOMAIN = "fakebloomberg/webhook-tombstone";
/** Anchored to the 90 day webhook-audit retention (spec §12 line 351). */
const TOMBSTONE_TTL_MS = 90 * 24 * 3_600_000;

export type TombstoneKey = Readonly<{ version: number; key: string }>;
export type TombstoneRecord = Readonly<{ keyVersion: number; hash: string; expiresAtMs: number }>;

/**
 * Domain-separated versioned HMAC tombstones over raw provider message ids
 * (spec §12 line 344). Lookup hashes the candidate under every key version an
 * unexpired tombstone references; a referenced key the registry no longer
 * holds fails raw storage closed, and a key cannot retire while an unexpired
 * tombstone still needs it.
 */
export class WebhookTombstoneRegistry {
  readonly #keys = new Map<number, Buffer>();
  #activeVersion: number;
  readonly #tombstones: TombstoneRecord[];
  readonly #suppressed = new Map<string, number>();
  readonly tombstoneTtlMs = TOMBSTONE_TTL_MS;

  constructor(keys: readonly TombstoneKey[], activeVersion: number, restored: readonly TombstoneRecord[] = []) {
    for (const { version, key } of keys) this.#keys.set(version, Buffer.from(key, "utf8"));
    if (!this.#keys.has(activeVersion)) throw new Error("webhook tombstone registry requires the active key");
    this.#activeVersion = activeVersion;
    this.#tombstones = [...restored];
  }

  #hash(keyVersion: number, provider: string, environment: string, rawProviderId: string): string {
    const key = this.#keys.get(keyVersion);
    if (key === undefined) throw new Error("webhook raw storage unavailable: tombstone key missing");
    return createHmac("sha256", key)
      .update(`${TOMBSTONE_DOMAIN}/v${keyVersion}|${provider}|${environment}|${rawProviderId}`)
      .digest("hex");
  }

  record(provider: string, environment: string, rawProviderId: string, nowMs: number): void {
    this.#tombstones.push({
      keyVersion: this.#activeVersion,
      hash: this.#hash(this.#activeVersion, provider, environment, rawProviderId),
      expiresAtMs: nowMs + this.tombstoneTtlMs,
    });
  }

  /** Throws (fail closed) when an unexpired tombstone references a key this registry no longer holds. */
  suppressed(provider: string, environment: string, rawProviderId: string, nowMs: number): boolean {
    const candidates = new Map<number, string>();
    for (const tombstone of this.#tombstones) {
      if (tombstone.expiresAtMs <= nowMs) continue;
      let candidate = candidates.get(tombstone.keyVersion);
      if (candidate === undefined) {
        candidate = this.#hash(tombstone.keyVersion, provider, environment, rawProviderId);
        candidates.set(tombstone.keyVersion, candidate);
      }
      if (tombstone.hash === candidate) return true;
    }
    return false;
  }

  rotateActive(version: number): void {
    if (!this.#keys.has(version)) throw new Error("webhook tombstone registry requires the active key");
    this.#activeVersion = version;
  }

  retireKey(version: number, nowMs: number): void {
    if (version === this.#activeVersion) throw new Error("cannot retire the active tombstone key");
    if (this.#tombstones.some((t) => t.keyVersion === version && t.expiresAtMs > nowMs)) {
      throw new Error("cannot retire a tombstone key before its last tombstone expires");
    }
    this.#keys.delete(version);
  }

  /** The bounded audit a tombstone match is allowed to write: one counter per (provider, environment). */
  countSuppressed(provider: string, environment: string): void {
    const key = `${provider}|${environment}`;
    this.#suppressed.set(key, (this.#suppressed.get(key) ?? 0) + 1);
  }

  suppressedCount(provider: string, environment: string): number {
    return this.#suppressed.get(`${provider}|${environment}`) ?? 0;
  }
}

/** Resend event type → append-only Delivery Fact kind. Engagement (open/click) is never promoted. */
const FACT_BY_EVENT: ReadonlyMap<string, DeliveryFactKind> = new Map([
  ["email.sent", "provider_accepted"],
  ["email.delivery_delayed", "delayed"],
  ["email.delivered", "delivered"],
  ["email.bounced", "bounced"],
  ["email.complained", "complained"],
  ["email.failed", "failed"],
]);

export type WebhookEnvelope = Readonly<{
  provider: string;
  environment: string;
  svixId: string;
  timestampSeconds: number;
  rawBody: string;
  signatureHeader: string;
}>;

export type WebhookInboxEntry = Readonly<{
  svixId: string;
  providerMessageId: string;
  eventType: string;
  factKind: DeliveryFactKind | undefined;
  owner: WebhookOwnerBinding | undefined;
}>;

export type WebhookAcceptOutcome =
  | Readonly<{
      status: "accepted";
      owner: WebhookOwnerBinding;
      factKind: DeliveryFactKind | undefined;
      svixId: string;
      providerMessageId: string;
    }>
  | Readonly<{ status: "unbound"; svixId: string; providerMessageId: string }>
  | Readonly<{ status: "duplicate" }>
  | Readonly<{ status: "suppressed"; reason: "erasure_tombstone" | "deletion_fence" }>
  | Readonly<{ status: "rejected"; reason: "missing_material" | "stale_timestamp" | "future_timestamp" | "signature_mismatch" | "parse_error" | "malformed_event" }>;

export class WebhookInbox {
  readonly #store = new FencedKeyedStore<WebhookInboxEntry>();

  constructor(
    private readonly directory: ProviderMessageDirectory,
    private readonly tombstones: WebhookTombstoneRegistry,
  ) {}

  accept(envelope: WebhookEnvelope, secret: string, nowMs: number, atEpoch: number): WebhookAcceptOutcome {
    const signature = verifyWebhookSignature(envelope, secret, nowMs);
    if (!signature.verified) return { status: "rejected", reason: signature.reason };

    let payload: unknown;
    try {
      payload = JSON.parse(envelope.rawBody);
    } catch {
      return { status: "rejected", reason: "parse_error" };
    }
    const event = payload as Readonly<{ type?: unknown; data?: Readonly<{ email_id?: unknown }> }>;
    const eventType = event.type;
    const providerMessageId = event.data?.email_id;
    if (typeof eventType !== "string" || typeof providerMessageId !== "string" || providerMessageId === "") {
      return { status: "rejected", reason: "malformed_event" };
    }

    if (this.tombstones.suppressed(envelope.provider, envelope.environment, providerMessageId, nowMs)) {
      this.tombstones.countSuppressed(envelope.provider, envelope.environment);
      return { status: "suppressed", reason: "erasure_tombstone" };
    }

    const owner = this.directory.lookup(providerMessageId);
    const subject = owner?.owner ?? `unbound:${envelope.provider}|${envelope.environment}`;
    const entry: WebhookInboxEntry = {
      svixId: envelope.svixId,
      providerMessageId,
      eventType,
      factKind: FACT_BY_EVENT.get(eventType),
      owner,
    };
    const dedupeKey = `${envelope.provider}|${envelope.environment}|${envelope.svixId}`;
    const { written, value } = this.#store.writeIfAbsent(subject, dedupeKey, entry, atEpoch);
    if (value === undefined) return { status: "suppressed", reason: "deletion_fence" };
    if (!written) return { status: "duplicate" };

    if (owner === undefined) return { status: "unbound", svixId: envelope.svixId, providerMessageId };
    return { status: "accepted", owner, factKind: entry.factKind, svixId: envelope.svixId, providerMessageId };
  }

  size(subject: string): number {
    return this.#store.size(subject);
  }

  list(subject: string): readonly WebhookInboxEntry[] {
    return this.#store.list(subject);
  }

  eraseSubject(subject: string, fence: number): number {
    return this.#store.eraseSubject(subject, fence);
  }
}
