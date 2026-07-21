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
import { KRX_HOLIDAYS, KRX_HOLIDAY_YEARS } from "./krx-holidays";

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
const INDEX_TR = "FHPUP02100000"; // 국내업종 현재지수 (ticket 31)

// Index symbols ride the same port: symbol → KRX 업종코드 (시장분류 U). Everything else is a stock
// ISCD. Same owner-only fence either way — an index quote from a personal key is still personal.
const INDEX_CODES: Readonly<Record<string, string>> = {
  KOSPI: "0001",
  KOSDAQ: "1001",
};

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

// KIS returns numeric fields as decimal STRINGS; anything else (null→0, true→1, "0x10"→16 under
// Number()) is a shape break that must fail closed, never coerce into a plausible price/point.
function toNumber(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const text = value.trim();
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
}

/** KIS business error (HTTP 200 with rt_cd ≠ "0") → typed failure. */
function businessFailure(msgCd: string | undefined, nowMs: number): ProviderFailureKind {
  // ponytail: only the observed rate-limit code is special-cased; other non-zero rt_cd → retryable
  // upstream. Widen the map as real KIS error codes surface via the opt-in contract test.
  if (msgCd === "EGW00201") return { kind: "quota", retryAfter: new Date(nowMs + 1_000).toISOString() }; // 초당 거래건수 초과
  return { kind: "upstream" };
}

// KRX regular continuous session: Mon–Fri 09:00–15:30 KST (UTC+9, no DST), excluding holidays.
// inquire-price carries no as-of timestamp, so freshness is derived from the wall clock: in-session the
// quote is a live trade (asOf = now); off-session (weekend / holiday / before-open / after-close) KIS
// returns the previous close, so asOf = the last trading session's close and the basis is eod — the
// freshness machine then ages it honestly instead of faking a realtime trade.
const KST_OFFSET_MS = 9 * 3_600_000;
const SESSION_OPEN_MIN = 9 * 60;
const SESSION_CLOSE_MIN = 15 * 60 + 30;

// `kst` is a Date whose UTC getters read the KST wall clock (nowMs already offset by KST_OFFSET_MS).
function krxDateKey(kst: Date): string {
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Closed = weekend, or a KRX holiday in a covered year. Outside covered years only weekends are known
// (the holiday list is a per-year static bundle) — there it under-marks holidays rather than fabricating.
function isKrxClosed(kst: Date): boolean {
  const dow = kst.getUTCDay(); // 0=Sun … 6=Sat, in KST
  if (dow === 0 || dow === 6) return true;
  if (!KRX_HOLIDAY_YEARS.has(kst.getUTCFullYear())) return false;
  return KRX_HOLIDAYS.has(krxDateKey(kst));
}

function krxSessionAsOf(nowMs: number): { asOfMs: number; basis: MarketObservation["priceBasis"] } {
  const kst = new Date(nowMs + KST_OFFSET_MS); // UTC getters now read the KST wall clock
  const minute = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const inSession = !isKrxClosed(kst) && minute >= SESSION_OPEN_MIN && minute < SESSION_CLOSE_MIN;
  if (inSession) {
    return { asOfMs: nowMs, basis: "trade" };
  }
  // Most recent session close: today 15:30 KST if today is a trading day past close, else step back to
  // the previous trading day's 15:30 (skipping weekends AND holidays).
  let closeWallMs = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 15, 30);
  const todayClosedAfterSession = !isKrxClosed(kst) && minute >= SESSION_CLOSE_MIN;
  if (!todayClosedAfterSession) {
    for (let back = 1; back <= 10; back++) {
      const probe = new Date(closeWallMs - back * 86_400_000);
      if (!isKrxClosed(probe)) {
        closeWallMs -= back * 86_400_000;
        break;
      }
    }
  }
  return { asOfMs: closeWallMs - KST_OFFSET_MS, basis: "eod" };
}

async function fetchQuote({ http, config }: KisDeps, token: string, symbol: string): Promise<KisHttpResponse> {
  const index = Object.hasOwn(INDEX_CODES, symbol);
  const path = index ? "inquire-index-price" : "inquire-price";
  const iscd = index ? (INDEX_CODES[symbol] as string) : symbol;
  return http({
    method: "GET",
    url:
      `${config.base}/uapi/domestic-stock/v1/quotations/${path}` +
      `?fid_cond_mrkt_div_code=${index ? "U" : "J"}&fid_input_iscd=${encodeURIComponent(iscd)}`,
    headers: {
      authorization: `Bearer ${token}`,
      appkey: config.appkey,
      appsecret: config.appsecret,
      tr_id: index ? INDEX_TR : QUOTE_TR,
      custtype: "P",
    },
  });
}

function toObservation(symbol: string, output: Record<string, unknown>, basis: MarketObservation["priceBasis"]) {
  const evidenceReference = brandReference<string, "EvidenceReference">(`evidence:f4:${symbol}:${FEED}`);
  const index = Object.hasOwn(INDEX_CODES, symbol);
  const value: MarketObservation = {
    symbol,
    last: toNumber(index ? output.bstp_nmix_prpr : output.stck_prpr),
    // Index levels are points, not a settlement currency — the display unit rides the field
    // (same convention as the treasury adapter's "%").
    currency: index ? "pt" : "KRW",
    change: toNumber(index ? output.bstp_nmix_prdy_vrss : output.prdy_vrss),
    changePercent: toNumber(index ? output.bstp_nmix_prdy_ctrt : output.prdy_ctrt),
    priceBasis: basis,
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
      const session = krxSessionAsOf(nowMs);
      const { value, evidenceReference } = toObservation(query.symbol, body.output ?? {}, session.basis);
      const asOf = new Date(session.asOfMs).toISOString();
      const available: AvailableInformation<MarketObservation> = {
        status: "available",
        value,
        evidenceReference,
        provider: PROVIDER,
        feed: FEED,
        venue: "KRX",
        asOf,
        receivedAt: occurredAt,
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
