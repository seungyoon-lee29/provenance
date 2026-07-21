import { brandReference } from "../../../shared/contracts/brands";
import type { AvailableInformation, InformationOutcome } from "@/shared";
import type { ViewerContext } from "@/shared/contracts/viewer-context";

import type {
  MarketInformation,
  MarketLoad,
  MarketObservation,
  MarketQuery,
  ProviderFailureKind,
} from "./contracts";
import {
  applyClassifiedObservationFreshness,
  type ObservationFreshnessClass,
} from "./observation-freshness";
import { OBSERVATION_POLICY_VERSION } from "./outcome-classification";
import { apiRequiredOutcome, classifyProviderFailure, noDataOutcome } from "./outcome-classification";
import { DATA_DEADLINE_MS, deadlineTimeoutOutcome, withDeadline, type Sleep } from "./deadline";

/**
 * 미 재무부 Daily Par Yield Curve 어댑터 (ticket 28-a). Implements the F4 `MarketInformation`
 * seam with the first PUBLIC (redistributable) provider: US-government data is public domain
 * (17 U.S.C. §105, ticket-27 probe), so every observation carries audience "public" — the
 * inverse of the KIS adapter's personal-only gate. Keyless: no credential ever exists here.
 *
 * The HTTP boundary is injected (`TreasuryHttp`) so the network-off suite drives the recorded
 * Atom/OData XML shape; the composition root supplies a real fetch-backed one pinned to the
 * official treasury.gov origin.
 */

export type TreasuryHttpRequest = Readonly<{ url: string }>;
export type TreasuryHttpResponse = Readonly<{ status: number; body: string }>;
export type TreasuryHttp = (request: TreasuryHttpRequest) => Promise<TreasuryHttpResponse>;

export type TreasuryClock = Readonly<{ now(): number; sleep: Sleep }>;

export type TreasuryConfig = Readonly<{
  base: string;
  /** validUntil for the public LicenseScope attached to every observation. */
  licenseValidUntil: string;
}>;

const PROVIDER = "treasury";
const FEED = "treasury:daily-par-yield-curve";

/** One tenor = one symbol (ticket 27 Q4): the XML field each public symbol reads. */
const TENOR_FIELDS: Readonly<Record<string, string>> = {
  UST2Y: "BC_2YEAR",
  UST10Y: "BC_10YEAR",
};

type TreasuryDeps = Readonly<{ http: TreasuryHttp; clock: TreasuryClock; config: TreasuryConfig }>;

function statusFailure(status: number, nowMs: number): ProviderFailureKind {
  if (status === 429) return { kind: "quota", retryAfter: new Date(nowMs + 60_000).toISOString() };
  if (status >= 500) return { kind: "upstream" };
  // Keyless feed: no auth statuses exist; anything else (404 = URL scheme drift) is a shape break.
  return { kind: "invalid_response" };
}

function yieldCurveUrl(base: string, year: number): string {
  return (
    `${base}/resource-center/data-chart-center/interest-rates/pages/xml` +
    `?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`
  );
}

// Treasury publishes each business day around 15:30 ET; 20:30Z is the DST-agnostic late bound
// (during DST the actual publication is ~19:30Z — expecting it an hour late only delays aging,
// it never overstates freshness of a superseded value beyond the spec'd +2h grace).
const PUBLICATION_MINUTES_UTC = 20 * 60 + 30;
const SOFT_GRACE_MS = 2 * 3_600_000; // spec §5.1: soft = next expected publication + 2h
const DAY_MS = 86_400_000;

/**
 * Spec §5.1 "Treasury·ECB daily": realtime until the next expected business-day publication +2h,
 * stale after one missed expected publication, no value after two. Expected publications are
 * weekdays; US federal holidays are unmodeled, which only ages a value FASTER (fail-closed
 * direction — a holiday counts as a missed publication). ponytail: weekday-only model, add a US
 * holiday bundle if a long holiday weekend visibly hard-expires a genuinely-latest curve.
 */
function classifyTreasuryFreshness(asOfMs: number, nowMs: number): ObservationFreshnessClass {
  if (asOfMs > nowMs) return { kind: "invalid", reason: "future_timestamp" };
  let missed = 0;
  let firstExpectedMs: number | undefined;
  for (let dayMs = asOfMs + DAY_MS; dayMs <= nowMs + DAY_MS && missed < 2; dayMs += DAY_MS) {
    const day = new Date(dayMs);
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const publicationMs =
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + PUBLICATION_MINUTES_UTC * 60_000;
    firstExpectedMs ??= publicationMs;
    if (publicationMs < nowMs) missed += 1;
  }
  if (missed === 0) return { kind: "fresh", freshness: "realtime" };
  if (missed === 1 && firstExpectedMs !== undefined && nowMs <= firstExpectedMs + SOFT_GRACE_MS) {
    return { kind: "fresh", freshness: "realtime" };
  }
  if (missed === 1) return { kind: "soft_expired", freshness: "stale" };
  return { kind: "hard_expired" };
}

type CurveEntry = Readonly<{ dateKey: string; asOfMs: number; fields: string }>;

// NEW_DATE arrives timezone-less ("2026-07-14T00:00:00"); Date.parse would read it in LOCAL time
// and break determinism, so only the date part is taken and pinned to UTC midnight. That marks the
// value slightly OLDER than the actual ~20:30Z publication — the conservative (honest) direction.
// Returns undefined when any entry carries an impossible calendar date (2026-02-30 would silently
// normalize to March): a feed that lies about dates is quarantined whole, not partially trusted.
function parseEntries(xml: string): CurveEntry[] | undefined {
  const entries: CurveEntry[] = [];
  for (const match of xml.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/g)) {
    const dateKey = /<(?:\w+:)?NEW_DATE(?:\s[^>]*)?>(\d{4}-\d{2}-\d{2})/.exec(match[0])?.[1];
    if (!dateKey) continue;
    const asOfMs = Date.parse(`${dateKey}T00:00:00.000Z`);
    if (!new Date(asOfMs).toISOString().startsWith(dateKey)) return undefined;
    entries.push({ dateKey, asOfMs, fields: match[0] });
  }
  // Duplicate dates are one revision: the later document entry supersedes the earlier one, and the
  // superseded revision never becomes the "prior publication" for change derivation.
  entries.sort((a, b) => a.asOfMs - b.asOfMs); // stable: same-date entries keep document order
  return entries.filter((entry, index) => entries[index + 1]?.dateKey !== entry.dateKey);
}

// Strict decimal lexicon before Number(): Number("0x10") is 16 and Number("") is 0 — either would
// fabricate a rate. Anything outside plain signed decimals fails closed via NaN.
function tenorValue(entry: CurveEntry, field: string): number {
  const raw = new RegExp(`<(?:\\w+:)?${field}(?:\\s[^>]*)?>([^<]*)<`).exec(entry.fields)?.[1]?.trim();
  return raw !== undefined && /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
}

/**
 * TTL cache + single-flight per URL for the composition transport: every guest request would
 * otherwise refetch the ~210KB yearly XML (anonymous upstream amplification against treasury.gov).
 * Only 200 responses are cached; failures and rejections fall through so the next read retries.
 * ponytail: keys are one-per-year URLs (bounded set), so TTL eviction alone is enough — no LRU.
 */
export function withTreasuryCache(inner: TreasuryHttp, now: () => number, ttlMs: number): TreasuryHttp {
  const cache = new Map<string, { expiresAtMs: number; response: Promise<TreasuryHttpResponse> }>();
  return (request) => {
    const hit = cache.get(request.url);
    if (hit && now() < hit.expiresAtMs) return hit.response;
    const response = inner(request).then((res) => {
      if (res.status !== 200) cache.delete(request.url);
      return res;
    });
    response.catch(() => cache.delete(request.url));
    cache.set(request.url, { expiresAtMs: now() + ttlMs, response });
    return response;
  };
}

/** Egress gate (spec §12.2, rights.md): with the treasury flag off, every read answers locally. */
export function createDisabledPublicMarketInformation(): MarketInformation {
  return {
    read(query: MarketQuery): MarketLoad {
      return {
        kind: "FinancialLoad",
        cache: "miss",
        query,
        result: Promise.resolve(apiRequiredOutcome("treasury_public_yield", "/settings/providers")),
      };
    },
    follow() {
      return {
        async *[Symbol.asyncIterator]() {
          return;
        },
      };
    },
  };
}

export function createPublicMarketInformation(deps: TreasuryDeps): MarketInformation {
  const { http, config, clock } = deps;

  async function fetchYear(year: number, nowMs: number): Promise<
    { ok: true; entries: CurveEntry[] } | { ok: false; failure: ProviderFailureKind }
  > {
    const res = await http({ url: yieldCurveUrl(config.base, year) });
    if (res.status < 200 || res.status >= 300) return { ok: false, failure: statusFailure(res.status, nowMs) };
    if (!res.body.includes("<feed")) return { ok: false, failure: { kind: "invalid_response" } };
    const entries = parseEntries(res.body);
    if (entries === undefined) return { ok: false, failure: { kind: "invalid_response" } };
    return { ok: true, entries };
  }

  async function settle(query: MarketQuery): Promise<InformationOutcome<MarketObservation>> {
    // Every read normalizes to an outcome (F4 contract): a throw becomes a typed failure, never a
    // rejected promise. occurredAt seeds a clock-independent fallback.
    let occurredAt = new Date().toISOString();
    try {
      const nowMs = clock.now();
      occurredAt = new Date(nowMs).toISOString();
      const field = TENOR_FIELDS[query.symbol] as string;
      const year = new Date(nowMs).getUTCFullYear();

      const current = await fetchYear(year, nowMs);
      if (!current.ok) return classifyProviderFailure({ failure: current.failure, provider: PROVIDER, feed: FEED, occurredAt });
      let entries = current.entries;
      // change needs the prior publication; in the first days of January the year feed has <2
      // entries, so merge the previous year once. Still <2 → the source is broken: refusing beats
      // fabricating a change of 0.
      if (entries.length < 2) {
        const previous = await fetchYear(year - 1, nowMs);
        if (!previous.ok) return classifyProviderFailure({ failure: previous.failure, provider: PROVIDER, feed: FEED, occurredAt });
        entries = [...previous.entries, ...entries].sort((a, b) => a.asOfMs - b.asOfMs);
      }
      if (entries.length < 2) {
        return classifyProviderFailure({ failure: { kind: "invalid_response" }, provider: PROVIDER, feed: FEED, occurredAt });
      }

      const latest = entries[entries.length - 1] as CurveEntry;
      const prior = entries[entries.length - 2] as CurveEntry;
      const last = tenorValue(latest, field);
      const priorLast = tenorValue(prior, field);
      const change = last - priorLast;
      // ponytail: a 0% prior rate (T-bill floor) would make the relative change infinite → report 0
      // relative change for that day rather than quarantining a real value.
      const changePercent = priorLast === 0 ? 0 : (change / priorLast) * 100;

      const evidenceReference = brandReference<string, "EvidenceReference">(`evidence:f4:${query.symbol}:${FEED}`);
      const available: AvailableInformation<MarketObservation> = {
        status: "available",
        value: {
          symbol: query.symbol,
          last,
          // Not a settlement currency: rates are quoted in percent, so the display unit rides the
          // currency field (ticket 27 Q4 — contract unchanged).
          currency: "%",
          change,
          changePercent,
          priceBasis: "eod",
          evidenceReference,
        },
        evidenceReference,
        provider: PROVIDER,
        feed: FEED,
        asOf: new Date(latest.asOfMs).toISOString(),
        receivedAt: occurredAt,
        freshness: "realtime",
        licenseScope: { audience: "public", purposes: ["public_display"], validUntil: config.licenseValidUntil },
        policyVersion: OBSERVATION_POLICY_VERSION,
      };
      return applyClassifiedObservationFreshness(available, { nowMs, classify: classifyTreasuryFreshness });
    } catch {
      return classifyProviderFailure({ failure: { kind: "timeout" }, provider: PROVIDER, feed: FEED, occurredAt });
    }
  }

  return {
    read(query: MarketQuery, viewer: ViewerContext): MarketLoad {
      void viewer; // public-domain data: every viewer (guest included) may read
      let result: Promise<InformationOutcome<MarketObservation>>;
      if (query.purpose !== "public_display") {
        // This adapter exists to serve the public feed; a personal_display read belongs to a
        // personal provider, so answer without touching the wire.
        result = Promise.resolve(apiRequiredOutcome("treasury_public_yield", "/settings/connections"));
      } else if (!Object.hasOwn(TENOR_FIELDS, query.symbol)) {
        // hasOwn, not lookup: "constructor" et al. resolve on the prototype chain and would leak
        // a non-string into the URL/regex path.
        result = Promise.resolve(noDataOutcome(query.symbol, new Date(clock.now()).toISOString()));
      } else {
        // Self-guarantees the §11.3 10s data deadline: a hung transport still resolves to a
        // timeout outcome (no infinite spinner), independent of any caller-applied deadline.
        result = withDeadline(settle(query), {
          deadlineMs: DATA_DEADLINE_MS,
          sleep: clock.sleep,
          onTimeout: () => deadlineTimeoutOutcome<MarketObservation>(PROVIDER, FEED, new Date().toISOString()),
        });
      }
      return { kind: "FinancialLoad", cache: "miss", query, result };
    },
    follow() {
      return {
        async *[Symbol.asyncIterator]() {
          return;
        },
      };
    },
  };
}
