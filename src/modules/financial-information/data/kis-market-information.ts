import { brandReference } from "../../../shared/contracts/brands";
import type { WorkspaceReference } from "../../../shared/contracts/brands";
import type { AvailableInformation, InformationOutcome } from "@/shared";
import type { ViewerContext } from "@/shared/contracts/viewer-context";

import type {
  MarketInformation,
  MarketLoad,
  MarketObservation,
  MarketQuery,
  ObservationExpiryPolicy,
  ProviderFailureKind,
} from "./contracts";
import { applyObservationFreshness, OBSERVATION_POLICY_VERSION } from "./observation-freshness";
import { apiRequiredOutcome, classifyProviderFailure } from "./outcome-classification";
import { DATA_DEADLINE_MS, deadlineTimeoutOutcome, withDeadline, type Sleep } from "./deadline";

/**
 * KIS 모의투자(:29443) REST 현재가 어댑터 (ticket 24). Implements the F4 `MarketInformation`
 * seam with a real personal provider. The HTTP boundary is injected (`KisHttp`) so the network-off
 * suite drives the recorded KIS JSON shape; the composition root supplies a real fetch-backed one.
 *
 * Personal-scope only (map line 16 — a personal key is never redistributed to a public feed or
 * another user's cache): served ONLY to the single owner workspace, ONLY for personal_display.
 */

export type KisHttpRequest = Readonly<{
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
}>;
export type KisHttpResponse = Readonly<{ status: number; json: unknown }>;
export type KisHttp = (request: KisHttpRequest) => Promise<KisHttpResponse>;

export type KisClock = Readonly<{ now(): number; sleep: Sleep }>;

export type KisConfig = Readonly<{
  base: string;
  appkey: string;
  appsecret: string;
  ownerWorkspaceReference: WorkspaceReference;
  policy: ObservationExpiryPolicy;
  /** validUntil for the personal LicenseScope attached to every observation. */
  licenseValidUntil: string;
}>;

const PROVIDER = "kis";
const FEED = "kis:domestic-quote";
const QUOTE_TR = "FHKST01010100"; // 국내주식 현재가 (probe-confirmed on :29443)

type KisDeps = Readonly<{ http: KisHttp; clock: KisClock; config: KisConfig }>;

// Refresh a minute early: KIS issues a token only once per minute, so re-issuing at hard expiry
// risks a 403 lockout. The skew keeps a live token in hand before the window closes.
const TOKEN_REFRESH_SKEW_MS = 60_000;

type TokenResult = Readonly<{ ok: true; token: string } | { ok: false; failure: ProviderFailureKind }>;

/** Quote-path HTTP-status → typed failure (a 403 here means the bearer token was rejected). */
function statusFailure(status: number, nowMs: number): ProviderFailureKind {
  if (status === 401) return { kind: "reauthentication_required" };
  if (status === 403) return { kind: "denied", denial: "credential" };
  if (status === 429) return { kind: "quota", retryAfter: new Date(nowMs + 60_000).toISOString() };
  if (status >= 500) return { kind: "upstream" };
  return { kind: "invalid_response" };
}

/**
 * Token-issuance failure → typed failure. Distinct from the quote path: on /oauth2/tokenP a 403 is
 * KIS's transient 1-request-per-minute limit (probe-observed "1분당 1회"), so it maps to retryable
 * quota — NOT a terminal reauthentication. 401 remains a genuine credential rejection.
 * ponytail: precise credential-vs-ratelimit 403 discrimination awaits the contract test's confirmed
 * error_code; treating token-403 as transient is the safe default (no value fabricated, quote skipped).
 */
function tokenFailure(status: number, nowMs: number): ProviderFailureKind {
  if (status === 401) return { kind: "reauthentication_required" };
  if (status === 403 || status === 429) return { kind: "quota", retryAfter: new Date(nowMs + 60_000).toISOString() };
  if (status >= 500) return { kind: "upstream" };
  return { kind: "invalid_response" };
}

/** KIS returns numeric fields as strings and "" for halted/no-data symbols; a blank must not read as 0. */
function toNumber(value: unknown): number {
  if (typeof value === "string" && value.trim() === "") return Number.NaN;
  return Number(value);
}

/** KIS business error (HTTP 200 with rt_cd ≠ "0") → typed failure. */
function businessFailure(msgCd: string | undefined, nowMs: number): ProviderFailureKind {
  // ponytail: only the observed rate-limit code is special-cased; other non-zero rt_cd → retryable
  // upstream. Widen the map as real KIS error codes surface via the opt-in contract test.
  if (msgCd === "EGW00201") return { kind: "quota", retryAfter: new Date(nowMs + 1_000).toISOString() }; // 초당 거래건수 초과
  return { kind: "upstream" };
}

async function fetchQuote({ http, config }: KisDeps, token: string, symbol: string): Promise<KisHttpResponse> {
  return http({
    method: "GET",
    url:
      `${config.base}/uapi/domestic-stock/v1/quotations/inquire-price` +
      `?fid_cond_mrkt_div_code=J&fid_input_iscd=${encodeURIComponent(symbol)}`,
    headers: {
      authorization: `Bearer ${token}`,
      appkey: config.appkey,
      appsecret: config.appsecret,
      tr_id: QUOTE_TR,
      custtype: "P",
    },
  });
}

function toObservation(symbol: string, output: Record<string, unknown>) {
  const evidenceReference = brandReference<string, "EvidenceReference">(`evidence:f4:${symbol}:${FEED}`);
  const value: MarketObservation = {
    symbol,
    last: toNumber(output.stck_prpr),
    currency: "KRW",
    change: toNumber(output.prdy_vrss),
    changePercent: toNumber(output.prdy_ctrt),
    priceBasis: "trade",
    evidenceReference,
  };
  return { value, evidenceReference };
}

export function createKisMarketInformation(deps: KisDeps): MarketInformation {
  const { http, config, clock } = deps;
  let cachedToken: { token: string; expiresAtMs: number } | undefined;
  let tokenInFlight: Promise<TokenResult> | undefined;

  // Single-flight: concurrent reads share ONE token issuance. Without this, a second read entering
  // before the first token POST resolves sees an empty cache and issues a second POST — hitting KIS's
  // 1-request-per-minute limit and defeating the cache's whole purpose (403 lockout).
  async function getToken(nowMs: number): Promise<TokenResult> {
    if (cachedToken && nowMs < cachedToken.expiresAtMs) return { ok: true, token: cachedToken.token };
    if (tokenInFlight) return tokenInFlight;
    tokenInFlight = (async (): Promise<TokenResult> => {
      try {
        const res = await http({
          method: "POST",
          url: `${config.base}/oauth2/tokenP`,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant_type: "client_credentials", appkey: config.appkey, appsecret: config.appsecret }),
        });
        const json = (res.json ?? {}) as { access_token?: unknown; expires_in?: unknown };
        if (res.status < 200 || res.status >= 300 || typeof json.access_token !== "string") {
          return { ok: false, failure: tokenFailure(res.status, nowMs) };
        }
        const ttlMs = (typeof json.expires_in === "number" ? json.expires_in : 0) * 1000;
        cachedToken = { token: json.access_token, expiresAtMs: nowMs + ttlMs - TOKEN_REFRESH_SKEW_MS };
        return { ok: true, token: cachedToken.token };
      } finally {
        tokenInFlight = undefined;
      }
    })();
    return tokenInFlight;
  }

  async function settle(query: MarketQuery): Promise<InformationOutcome<MarketObservation>> {
    // Every read normalizes to an outcome (F4 contract): a clock/transport throw or a malformed body
    // becomes a typed failure, never a rejected promise. occurredAt seeds a clock-independent fallback.
    let occurredAt = new Date().toISOString();
    try {
      const nowMs = clock.now();
      occurredAt = new Date(nowMs).toISOString();
      const tokenResult = await getToken(nowMs);
      if (!tokenResult.ok) {
        return classifyProviderFailure({ failure: tokenResult.failure, provider: PROVIDER, feed: FEED, occurredAt });
      }
      const res = await fetchQuote(deps, tokenResult.token, query.symbol);
      if (res.status < 200 || res.status >= 300) {
        return classifyProviderFailure({ failure: statusFailure(res.status, nowMs), provider: PROVIDER, feed: FEED, occurredAt });
      }
      const body = (res.json ?? {}) as { rt_cd?: unknown; msg_cd?: unknown; output?: Record<string, unknown> };
      if (body.rt_cd !== "0") {
        const msgCd = typeof body.msg_cd === "string" ? body.msg_cd : undefined;
        return classifyProviderFailure({ failure: businessFailure(msgCd, nowMs), provider: PROVIDER, feed: FEED, occurredAt });
      }
      const { value, evidenceReference } = toObservation(query.symbol, body.output ?? {});
      const asOf = occurredAt;
      const available: AvailableInformation<MarketObservation> = {
        status: "available",
        value,
        evidenceReference,
        provider: PROVIDER,
        feed: FEED,
        venue: "KRX",
        asOf,
        receivedAt: asOf,
        freshness: "realtime",
        licenseScope: { audience: "personal", purposes: ["personal_display"], validUntil: config.licenseValidUntil },
        policyVersion: OBSERVATION_POLICY_VERSION,
      };
      return applyObservationFreshness(available, { nowMs, policy: config.policy });
    } catch {
      return classifyProviderFailure({ failure: { kind: "timeout" }, provider: PROVIDER, feed: FEED, occurredAt });
    }
  }

  // No-redistribution gate (map line 16): the personal key touches the wire ONLY for the single
  // owner workspace asking for personal_display. Any other viewer/purpose gets a no-value outcome
  // with zero network — the key is never used on behalf of a guest, another workspace, or a public feed.
  function servesOwner(query: MarketQuery, viewer: ViewerContext): boolean {
    return (
      viewer.kind === "workspace" &&
      viewer.workspaceReference === config.ownerWorkspaceReference &&
      query.purpose === "personal_display"
    );
  }

  return {
    read(query: MarketQuery, viewer: ViewerContext): MarketLoad {
      if (!servesOwner(query, viewer)) {
        return {
          kind: "FinancialLoad",
          cache: "miss",
          query,
          result: Promise.resolve(apiRequiredOutcome("kis_personal_quote", "/settings/connections")),
        };
      }
      // The adapter self-guarantees the §11.3 10s data deadline: a hung transport still resolves to a
      // timeout outcome (no infinite spinner), independent of any caller-applied deadline.
      const result = withDeadline(settle(query), {
        deadlineMs: DATA_DEADLINE_MS,
        sleep: clock.sleep,
        onTimeout: () => deadlineTimeoutOutcome<MarketObservation>(PROVIDER, FEED, new Date().toISOString()),
      });
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
