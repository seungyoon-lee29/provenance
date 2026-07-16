import { createHash, randomBytes } from "node:crypto";

import { FencedKeyedStore } from "./fenced-store";

/**
 * F5 RFC 8058 one-click unsubscribe (spec §12 lines 342 and 345).
 *
 * A token is ≥256 bits, stored hash-only, and bound to the exact
 * workspace/endpoint/topic/channel/consent lineage it was issued for. GET never
 * consumes; only a POST whose body is exactly one `List-Unsubscribe=One-Click`
 * text field consumes, idempotently. Ingress limits and IP-prefix/global flood
 * caps apply before buffering, and the invalid audit is keyed WITHOUT any
 * token-derived value so an attacker cannot grow storage per guessed token.
 */
export type UnsubscribeLineage = Readonly<{
  workspace: string;
  endpoint: string;
  topic: string;
  channel: string;
  consentRevision: number;
}>;

export type UnsubscribeTokenEntry = Readonly<{
  tokenHash: string;
  lineage: UnsubscribeLineage;
  issuedAtMs: number;
  atEpoch: number;
  consumedAtMs?: number;
}>;

function tokenHash(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export class UnsubscribeTokenStore {
  readonly #store = new FencedKeyedStore<UnsubscribeTokenEntry>();
  readonly #workspaceByHash = new Map<string, string>();

  /** Returns the raw token (never stored) or undefined when the workspace is erased. */
  issue(lineage: UnsubscribeLineage, nowMs: number, atEpoch: number): string | undefined {
    const raw = randomBytes(32).toString("base64url");
    const hash = tokenHash(raw);
    const entry: UnsubscribeTokenEntry = { tokenHash: hash, lineage, issuedAtMs: nowMs, atEpoch };
    if (!this.#store.write(lineage.workspace, hash, entry, atEpoch)) return undefined;
    this.#workspaceByHash.set(hash, lineage.workspace);
    return raw;
  }

  /** Idempotent consume: an already-consumed token re-reports the same revocation. */
  consume(rawToken: string, nowMs: number): UnsubscribeLineage | undefined {
    const hash = tokenHash(rawToken);
    const workspace = this.#workspaceByHash.get(hash);
    if (workspace === undefined) return undefined;
    const entry = this.#store.get(workspace, hash);
    if (entry === undefined) return undefined;
    if (entry.consumedAtMs === undefined) {
      this.#store.write(workspace, hash, { ...entry, consumedAtMs: nowMs }, entry.atEpoch);
    }
    return entry.lineage;
  }

  entries(workspace: string): readonly UnsubscribeTokenEntry[] {
    return this.#store.list(workspace);
  }

  eraseSubject(workspace: string, fence: number): number {
    for (const [hash, owner] of this.#workspaceByHash) {
      if (owner === workspace) this.#workspaceByHash.delete(hash);
    }
    return this.#store.eraseSubject(workspace, fence);
  }
}

export type FormField = Readonly<{ name: string; value: string; kind: "text" | "file" }>;

export function parseUrlencodedFields(rawBody: string): readonly FormField[] {
  return [...new URLSearchParams(rawBody)].map(([name, value]) => ({ name, value, kind: "text" as const }));
}

export type UnsubscribeRequest = Readonly<{
  method: string;
  token: string;
  fields: readonly FormField[];
}>;

export type UnsubscribeOutcome =
  | Readonly<{ status: "render_confirmation" }>
  | Readonly<{ status: "unsubscribed"; lineage: UnsubscribeLineage }>
  | Readonly<{ status: "invalid"; reason: "method_not_allowed" | "malformed_one_click" | "unknown_token" }>;

export function handleUnsubscribe(request: UnsubscribeRequest, store: UnsubscribeTokenStore, nowMs: number): UnsubscribeOutcome {
  // RFC 8058: a GET (mail-client prefetch, link scanner) only renders — never consumes.
  if (request.method === "GET") return { status: "render_confirmation" };
  if (request.method !== "POST") return { status: "invalid", reason: "method_not_allowed" };
  const [field] = request.fields;
  if (request.fields.length !== 1 || field === undefined || field.kind !== "text" || field.name !== "List-Unsubscribe" || field.value !== "One-Click") {
    return { status: "invalid", reason: "malformed_one_click" };
  }
  const lineage = store.consume(request.token, nowMs);
  if (lineage === undefined) return { status: "invalid", reason: "unknown_token" };
  return { status: "unsubscribed", lineage };
}

export const UNSUBSCRIBE_INGRESS = {
  maxUrlBytes: 4 * 1024,
  maxBodyBytes: 8 * 1024,
  maxHeaders: 64,
  maxHeaderBytes: 16 * 1024,
  deadlineMs: 2_000,
  ipPrefixPerMinute: 10,
  ipPrefixPerDay: 100,
  globalPerSecond: 50,
} as const;

export type UnsubscribeIngressRequest = Readonly<{
  urlBytes: number;
  bodyBytes: number;
  headerCount: number;
  headerBytes: number;
}>;

export type UnsubscribeIngressOutcome =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: "url_too_large" | "body_too_large" | "too_many_headers" | "headers_too_large" }>;

export function checkUnsubscribeIngress(request: UnsubscribeIngressRequest): UnsubscribeIngressOutcome {
  if (request.urlBytes > UNSUBSCRIBE_INGRESS.maxUrlBytes) return { allowed: false, reason: "url_too_large" };
  if (request.bodyBytes > UNSUBSCRIBE_INGRESS.maxBodyBytes) return { allowed: false, reason: "body_too_large" };
  if (request.headerCount > UNSUBSCRIBE_INGRESS.maxHeaders) return { allowed: false, reason: "too_many_headers" };
  if (request.headerBytes > UNSUBSCRIBE_INGRESS.maxHeaderBytes) return { allowed: false, reason: "headers_too_large" };
  return { allowed: true };
}

export type UnsubscribeAdmission = "admitted" | "ip_minute_limited" | "ip_day_limited" | "global_limited";

/** Fixed-window counters: IP prefix 10/minute and 100/day, 50/second globally. */
export class UnsubscribeFloodLimiter {
  readonly #minute = new Map<string, number>();
  readonly #day = new Map<string, number>();
  readonly #second = new Map<number, number>();

  admit(ipPrefix: string, nowMs: number): UnsubscribeAdmission {
    const minuteKey = `${ipPrefix}|${Math.floor(nowMs / 60_000)}`;
    const dayKey = `${ipPrefix}|${Math.floor(nowMs / 86_400_000)}`;
    const second = Math.floor(nowMs / 1_000);
    if ((this.#minute.get(minuteKey) ?? 0) >= UNSUBSCRIBE_INGRESS.ipPrefixPerMinute) return "ip_minute_limited";
    if ((this.#day.get(dayKey) ?? 0) >= UNSUBSCRIBE_INGRESS.ipPrefixPerDay) return "ip_day_limited";
    if ((this.#second.get(second) ?? 0) >= UNSUBSCRIBE_INGRESS.globalPerSecond) return "global_limited";
    this.#minute.set(minuteKey, (this.#minute.get(minuteKey) ?? 0) + 1);
    this.#day.set(dayKey, (this.#day.get(dayKey) ?? 0) + 1);
    this.#second.set(second, (this.#second.get(second) ?? 0) + 1);
    return "admitted";
  }
}

export const UNSUBSCRIBE_AUDIT_SAMPLES_PER_HOUR = 20;

/**
 * Invalid-request audit with NO token-derived keys: counters keyed by
 * `route|reason|minute|edgeRegion`, at most 20 full samples per hour globally,
 * and a 24h row cap of routes×reasons×regions×1440+480 as a cardinality
 * backstop. Rows persist until `prune` (the retention sweep) frees them.
 */
export class UnsubscribeInvalidAudit {
  readonly rowCap: number;
  readonly #rows = new Map<string, number>();
  readonly #samplesByHour = new Map<number, number>();

  constructor(routes: readonly string[], reasons: readonly string[], regions: readonly string[]) {
    this.rowCap = routes.length * reasons.length * regions.length * 1_440 + 480;
  }

  record(route: string, reason: string, edgeRegion: string, nowMs: number): Readonly<{ counted: boolean; sampled: boolean }> {
    const minute = Math.floor(nowMs / 60_000);
    const key = `${route}|${reason}|${minute}|${edgeRegion}`;
    const existing = this.#rows.get(key);
    if (existing === undefined && this.#rows.size >= this.rowCap) return { counted: false, sampled: false };
    this.#rows.set(key, (existing ?? 0) + 1);
    const hour = Math.floor(nowMs / 3_600_000);
    const sampledSoFar = this.#samplesByHour.get(hour) ?? 0;
    const sampled = sampledSoFar < UNSUBSCRIBE_AUDIT_SAMPLES_PER_HOUR;
    if (sampled) this.#samplesByHour.set(hour, sampledSoFar + 1);
    return { counted: true, sampled };
  }

  /** Retention sweep: drop counter rows older than 24 hours. */
  prune(nowMs: number): void {
    const cutoffMinute = Math.floor(nowMs / 60_000) - 1_440;
    for (const key of this.#rows.keys()) {
      const minute = Number(key.split("|")[2]);
      if (minute < cutoffMinute) this.#rows.delete(key);
    }
  }

  rows(): readonly Readonly<{ key: string; count: number }>[] {
    return [...this.#rows].map(([key, count]) => ({ key, count }));
  }
}
