import catalogJson from "../../../../fixtures/spec/f4/market-catalog.json";
import { brandReference } from "../../../shared/contracts/brands";
import type { AvailableInformation, InformationOutcome, PolicyVersion } from "@/shared";
import { z } from "zod";

import type { MarketInformation, MarketLoad, MarketObservation, MarketQuery } from "./contracts";
import { applyObservationFreshness, OBSERVATION_POLICY_VERSION } from "./observation-freshness";
import { apiRequiredOutcome, classifyProviderFailure, noDataOutcome } from "./outcome-classification";

const SLOW_MISS_SETTLE_MS = 300;

export interface MarketClock {
  now(): number;
  sleep(durationMs: number, signal?: AbortSignal): Promise<void>;
}

const licenseScopeSchema = z.object({
  audience: z.enum(["public", "personal", "internal_test_only"]),
  purposes: z.array(z.string().min(1)).min(1),
  validUntil: z.iso.datetime(),
}).strict();

const residualPolicySchema = z.object({
  kind: z.literal("residual"),
  declaredDelayMs: z.number().nonnegative(),
  softResidualMs: z.number().positive(),
  hardResidualMs: z.number().positive(),
}).strict();

const cadencePolicySchema = z.object({
  kind: z.literal("cadence"),
  cadenceMs: z.number().positive(),
  softGraceMs: z.number().nonnegative(),
  hardMissedPublications: z.number().int().positive(),
}).strict();

const valueSchema = z.object({
  last: z.number(),
  currency: z.string().min(1),
  change: z.number(),
  changePercent: z.number(),
  priceBasis: z.enum(["trade", "eod", "indicative", "delayed_sip"]),
}).strict();

const failureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reauthentication_required") }).strict(),
  z.object({ kind: z.literal("denied"), denial: z.enum(["entitlement", "credential", "other"]) }).strict(),
  z.object({ kind: z.literal("quota"), retryAfter: z.iso.datetime() }).strict(),
  z.object({ kind: z.literal("timeout") }).strict(),
  z.object({ kind: z.literal("upstream") }).strict(),
  z.object({ kind: z.literal("invalid_response") }).strict(),
]);

const scenarioSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("observation"),
    feed: z.string().min(1),
    asOf: z.iso.datetime(),
    policy: z.union([residualPolicySchema, cadencePolicySchema]),
    value: valueSchema,
    malform: z.literal("nan_last").optional(),
  }).strict(),
  z.object({
    type: z.literal("failure"),
    feed: z.string().min(1),
    failure: failureSchema,
    source: z.string().min(1).optional(),
    purpose: z.string().min(1).optional(),
  }).strict(),
  z.object({ type: z.literal("api_required"), requiredCapability: z.string().min(1), configurationRoute: z.string().min(1) }).strict(),
  z.object({ type: z.literal("no_data"), queryRange: z.string().min(1), asOf: z.iso.datetime() }).strict(),
]);

const caseSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  cache: z.enum(["hit", "miss"]),
  settleAfterMs: z.number().nullable().optional(),
  scenario: scenarioSchema,
  expected: z.unknown(),
}).strict();

const catalogSchema = z.object({
  marker: z.literal("SYNTHETIC TEST DATA"),
  provider: z.literal("synthetic"),
  isSynthetic: z.literal(true),
  now: z.iso.datetime(),
  licenseScope: licenseScopeSchema,
  cases: z.array(caseSchema).min(1),
}).strict();

export type MarketCatalog = z.infer<typeof catalogSchema>;
type MarketCase = z.infer<typeof caseSchema>;
type MarketScenario = MarketCase["scenario"];

export function loadSyntheticMarketCatalog(): MarketCatalog {
  return catalogSchema.parse(catalogJson);
}

const fixturePolicyVersion: PolicyVersion = OBSERVATION_POLICY_VERSION;

/** Fixed-clock so the scenario as-of/now math is deterministic across runs. */
export function catalogClock(catalog = loadSyntheticMarketCatalog()): MarketClock {
  const nowMs = Date.parse(catalog.now);
  return {
    now: () => nowMs,
    sleep: (durationMs, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(resolve, durationMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      }),
  };
}

function evidenceRef(symbol: string, feed: string) {
  return brandReference<string, "EvidenceReference">(`evidence:f4:${symbol}:${feed}`);
}

function buildOutcome(
  symbol: string,
  scenario: MarketScenario,
  licenseScope: MarketCatalog["licenseScope"],
  nowMs: number,
): InformationOutcome<MarketObservation> {
  const occurredAt = new Date(nowMs).toISOString();
  if (scenario.type === "api_required") {
    return apiRequiredOutcome(scenario.requiredCapability, scenario.configurationRoute);
  }
  if (scenario.type === "no_data") {
    return noDataOutcome(scenario.queryRange, scenario.asOf);
  }
  if (scenario.type === "failure") {
    return classifyProviderFailure({
      failure: scenario.failure,
      provider: "synthetic",
      feed: scenario.feed,
      occurredAt,
      source: scenario.source,
      purpose: scenario.purpose,
    });
  }
  const reference = evidenceRef(symbol, scenario.feed);
  const observation: MarketObservation = {
    symbol,
    last: scenario.malform === "nan_last" ? Number.NaN : scenario.value.last,
    currency: scenario.value.currency,
    change: scenario.value.change,
    changePercent: scenario.value.changePercent,
    priceBasis: scenario.value.priceBasis,
    evidenceReference: reference,
  };
  const available: AvailableInformation<MarketObservation> = {
    status: "available",
    value: observation,
    evidenceReference: reference,
    provider: "synthetic",
    feed: scenario.feed,
    venue: "SYNTHETIC",
    asOf: scenario.asOf,
    receivedAt: occurredAt,
    freshness: "realtime",
    licenseScope,
    policyVersion: fixturePolicyVersion,
  };
  return applyObservationFreshness(available, { nowMs, policy: scenario.policy });
}

/**
 * Fixture-backed non-chart FinancialInformation. Each catalog symbol drives one
 * scenario through the freshness/error normalization machine so the observable
 * outcome matrix (AT-01) is produced, not replayed.
 */
export function createScriptedMarketInformation(
  clock: MarketClock,
  catalog = loadSyntheticMarketCatalog(),
): MarketInformation {
  const caseBySymbol = new Map<string, MarketCase>(catalog.cases.map((entry) => [entry.symbol, entry]));

  return {
    read(query: MarketQuery): MarketLoad {
      const found = caseBySymbol.get(query.symbol);
      const nowMs = clock.now();
      if (!found) {
        return {
          kind: "FinancialLoad",
          cache: "miss",
          query,
          result: Promise.resolve(noDataOutcome(query.symbol, new Date(nowMs).toISOString())),
        };
      }
      const settle = (): InformationOutcome<MarketObservation> =>
        buildOutcome(query.symbol, found.scenario, catalog.licenseScope, nowMs);

      if (found.cache === "miss" && found.settleAfterMs === null) {
        // deadline scenario: never settles from cache; the caller's deadline resolves it.
        return { kind: "FinancialLoad", cache: "miss", query, result: Promise.resolve(settle()) };
      }
      if (found.cache === "miss") {
        return { kind: "FinancialLoad", cache: "miss", query, result: clock.sleep(SLOW_MISS_SETTLE_MS).then(settle) };
      }
      return { kind: "FinancialLoad", cache: "hit", query, result: Promise.resolve(settle()) };
    },
    follow() {
      return { async *[Symbol.asyncIterator]() { return; } };
    },
  };
}
