import type {
  EvidenceReference,
  FinancialInformation,
  FinancialLoad,
  FinancialQuery,
  InformationOutcome,
} from "@/shared";
import type { ViewerContext } from "@/shared/contracts/viewer-context";

/**
 * Non-chart FinancialInformation (F4): market observations plus news/filing
 * evidence. Every read normalizes raw provider facts into the shared
 * `InformationOutcome<T>` — a value exists only on `available`, which the type
 * system enforces (Prevent layer). Chart data lives in ../chart.
 */

export type MarketPriceBasis = "trade" | "eod" | "indicative" | "delayed_sip";

/** The value carried by an `available` market observation. */
export type MarketObservation = Readonly<{
  symbol: string;
  last: number;
  currency: string;
  change: number;
  changePercent: number;
  priceBasis: MarketPriceBasis;
  evidenceReference: EvidenceReference;
}>;

export type MarketQuery = FinancialQuery & Readonly<{
  symbol: string;
  purpose: "public_display" | "personal_display";
  requestRevision: string;
}>;

export type MarketLoad = FinancialLoad & Readonly<{
  cache: "hit" | "miss";
  query: MarketQuery;
  result: Promise<InformationOutcome<MarketObservation>>;
}>;

export interface MarketInformation extends FinancialInformation {
  read(query: MarketQuery, viewer: ViewerContext): MarketLoad;
}

/**
 * Soft/hard expiry policy for a feed+purpose (§5.1 table). `residual` covers
 * feeds whose freshness is measured as lag from market/as-of time (IEX, KIS,
 * Paper fill, delayed SIP, intraday bars). `cadence` covers scheduled
 * publications (Treasury/ECB daily, KRX EOD, SEC/DART) where hard expiry is a
 * count of missed expected publications.
 */
export type ObservationExpiryPolicy =
  | Readonly<{
      kind: "residual";
      declaredDelayMs: number;
      softResidualMs: number;
      hardResidualMs: number;
    }>
  | Readonly<{
      kind: "cadence";
      cadenceMs: number;
      /** grace after the next expected publication before `stale`. */
      softGraceMs: number;
      /** number of consecutive missed expected publications that hard-expire the value. */
      hardMissedPublications: number;
    }>;

/** Provider-signaled classification of a non-2xx / non-value response (§5.1 last paragraph). */
export type ProviderFailureKind =
  | Readonly<{ kind: "reauthentication_required" }> // 401
  | Readonly<{ kind: "denied"; denial: "entitlement" | "credential" | "other" }> // 403 family
  | Readonly<{ kind: "quota"; retryAfter: string }> // 429 / quota
  | Readonly<{ kind: "timeout" }> // client timeout / 504
  | Readonly<{ kind: "upstream" }> // 5xx
  | Readonly<{ kind: "invalid_response" }>; // malformed / future timestamp
