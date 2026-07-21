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
  classifyBusinessDayPublicationFreshness,
} from "./observation-freshness";
import { OBSERVATION_POLICY_VERSION } from "./outcome-classification";
import { apiRequiredOutcome, classifyProviderFailure, noDataOutcome } from "./outcome-classification";
import { DATA_DEADLINE_MS, deadlineTimeoutOutcome, withDeadline, type Sleep } from "./deadline";

/**
 * ECB 일별 기준환율 교차 어댑터 (ticket 32-a) — second public (redistributable-with-attribution)
 * provider. USD/KRW is not an ECB series: it is DERIVED from two published EUR-based reference
 * rates (KRW.EUR ÷ USD.EUR), so the observation says so — priceBasis "indicative", feed named
 * "cross", and a cross exists ONLY on dates where BOTH series published. Keyless.
 */

export type EcbHttpRequest = Readonly<{ url: string }>;
export type EcbHttpResponse = Readonly<{ status: number; body: string }>;
export type EcbHttp = (request: EcbHttpRequest) => Promise<EcbHttpResponse>;

export type EcbClock = Readonly<{ now(): number; sleep: Sleep }>;

export type EcbConfig = Readonly<{
  base: string;
  /** validUntil for the public LicenseScope attached to every observation. */
  licenseValidUntil: string;
}>;

const PROVIDER = "ecb";
const FEED = "ecb:reference-cross";

// One pair for now: KRW per USD from the two EUR-denominated reference series.
const CROSS = { numerator: "KRW", denominator: "USD" } as const;
export const ECB_FX_SYMBOLS: ReadonlySet<string> = new Set(["USDKRW"]);

// ECB reference rates are published once per business day around 16:00 CET; 15:30Z is the
// DST-agnostic late bound (same convention as the treasury adapter — lateness only delays aging).
const PUBLICATION_MINUTES_UTC = 15 * 60 + 30;
const SOFT_GRACE_MS = 2 * 3_600_000; // spec §5.1: soft = next expected publication + 2h

// Enough business days to guarantee ≥2 common publication dates across short holiday gaps.
const OBSERVATION_WINDOW = 8;

type EcbDeps = Readonly<{ http: EcbHttp; clock: EcbClock; config: EcbConfig }>;

function statusFailure(status: number, nowMs: number): ProviderFailureKind {
  if (status === 429) return { kind: "quota", retryAfter: new Date(nowMs + 60_000).toISOString() };
  if (status >= 500) return { kind: "upstream" };
  return { kind: "invalid_response" };
}

function seriesUrl(base: string): string {
  return (
    `${base}/service/data/EXR/D.${CROSS.denominator}+${CROSS.numerator}.EUR.SP00.A` +
    `?lastNObservations=${OBSERVATION_WINDOW}&format=csvdata`
  );
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * csvdata rows: CURRENCY(2), TIME_PERIOD(6), OBS_VALUE(7) all precede the first quotable column,
 * so a naive comma split is positionally safe there; every extracted field is then strictly
 * validated, so a misaligned row fails closed instead of becoming a wrong number.
 * Returns date → rate per currency, or undefined when the body is not the expected CSV.
 */
function parseSeries(body: string): Map<string, { KRW?: number; USD?: number }> | undefined {
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  const header = lines[0]?.split(",") ?? [];
  const currencyAt = header.indexOf("CURRENCY");
  const dateAt = header.indexOf("TIME_PERIOD");
  const valueAt = header.indexOf("OBS_VALUE");
  if (currencyAt < 0 || dateAt < 0 || valueAt < 0) return undefined;

  const byDate = new Map<string, { KRW?: number; USD?: number }>();
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const currency = cells[currencyAt];
    const date = cells[dateAt];
    const raw = cells[valueAt];
    if ((currency !== "KRW" && currency !== "USD") || !date || !DATE_KEY.test(date)) return undefined;
    if (raw === undefined || !DECIMAL.test(raw)) return undefined;
    const entry = byDate.get(date) ?? {};
    byDate.set(date, { ...entry, [currency]: Number(raw) });
  }
  return byDate;
}

export function createEcbFxInformation(deps: EcbDeps): MarketInformation {
  const { http, config, clock } = deps;

  async function settle(query: MarketQuery): Promise<InformationOutcome<MarketObservation>> {
    let occurredAt = new Date().toISOString();
    try {
      const nowMs = clock.now();
      occurredAt = new Date(nowMs).toISOString();

      const res = await http({ url: seriesUrl(config.base) });
      if (res.status < 200 || res.status >= 300) {
        return classifyProviderFailure({ failure: statusFailure(res.status, nowMs), provider: PROVIDER, feed: FEED, occurredAt });
      }
      const byDate = parseSeries(res.body);
      if (byDate === undefined) {
        return classifyProviderFailure({ failure: { kind: "invalid_response" }, provider: PROVIDER, feed: FEED, occurredAt });
      }

      // A cross exists only where BOTH series published; a positive denominator is part of validity.
      const common = [...byDate.entries()]
        .filter(([, rates]) => rates.KRW !== undefined && rates.USD !== undefined && rates.USD > 0 && rates.KRW > 0)
        .sort(([a], [b]) => (a < b ? -1 : 1));
      if (common.length < 2) {
        // One common date cannot yield an honest change; zero means the feed shape broke.
        return classifyProviderFailure({ failure: { kind: "invalid_response" }, provider: PROVIDER, feed: FEED, occurredAt });
      }

      const [latestDate, latestRates] = common[common.length - 1] as [string, { KRW: number; USD: number }];
      const [, priorRates] = common[common.length - 2] as [string, { KRW: number; USD: number }];
      const last = latestRates.KRW / latestRates.USD;
      const priorCross = priorRates.KRW / priorRates.USD;
      const change = last - priorCross;

      const evidenceReference = brandReference<string, "EvidenceReference">(`evidence:f4:${query.symbol}:${FEED}`);
      const available: AvailableInformation<MarketObservation> = {
        status: "available",
        value: {
          symbol: query.symbol,
          last,
          currency: "KRW",
          change,
          changePercent: (change / priorCross) * 100,
          priceBasis: "indicative", // derived reference cross, not a traded price
          evidenceReference,
        },
        evidenceReference,
        provider: PROVIDER,
        feed: FEED,
        asOf: new Date(Date.parse(`${latestDate}T00:00:00.000Z`)).toISOString(),
        receivedAt: occurredAt,
        freshness: "realtime",
        licenseScope: { audience: "public", purposes: ["public_display"], validUntil: config.licenseValidUntil },
        policyVersion: OBSERVATION_POLICY_VERSION,
      };
      return applyClassifiedObservationFreshness(available, {
        nowMs,
        classify: (asOfMs, atMs) =>
          classifyBusinessDayPublicationFreshness({
            asOfMs,
            nowMs: atMs,
            publicationMinutesUtc: PUBLICATION_MINUTES_UTC,
            softGraceMs: SOFT_GRACE_MS,
          }),
      });
    } catch {
      return classifyProviderFailure({ failure: { kind: "timeout" }, provider: PROVIDER, feed: FEED, occurredAt });
    }
  }

  return {
    read(query: MarketQuery, viewer: ViewerContext): MarketLoad {
      void viewer; // public-domain-with-attribution data: every viewer may read
      let result: Promise<InformationOutcome<MarketObservation>>;
      if (query.purpose !== "public_display") {
        result = Promise.resolve(apiRequiredOutcome("ecb_public_fx", "/settings/connections"));
      } else if (!ECB_FX_SYMBOLS.has(query.symbol)) {
        result = Promise.resolve(noDataOutcome(query.symbol, new Date(clock.now()).toISOString()));
      } else {
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
