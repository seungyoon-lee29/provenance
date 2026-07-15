import catalogJson from "../../../../fixtures/spec/f2/chart-catalog.json";
import { brandReference } from "../../../shared/contracts/brands";
import type { AvailableInformation, InformationOutcome, PolicyVersion } from "@/shared";
import { z } from "zod";

import { applyChartFreshness, chartTimeoutOutcome, intervalToMs, resolveWithStaleIfError } from "./chart-freshness";
import { resolveChartWindow } from "./chart-manifest";
import { buildChartSeries, chartEvidenceReference, synthesizeChartBars } from "./chart-series";
import type {
  ChartBar,
  ChartClock,
  ChartInformation,
  ChartLoad,
  ChartQuery,
  ChartSelection,
  ChartSeriesValue,
} from "./contracts";

const SLOW_MISS_SETTLE_MS = 300;

const scenarioSchema = z.enum(["fresh", "soft_expired", "stale_error", "slow_miss", "never", "future", "malformed"]);

const catalogSchema = z.object({
  marker: z.literal("SYNTHETIC TEST DATA"),
  provider: z.literal("synthetic"),
  isSynthetic: z.literal(true),
  licenseScope: z.object({
    audience: z.enum(["public", "personal", "internal_test_only"]),
    purposes: z.array(z.string().min(1)).min(1),
    validUntil: z.iso.datetime(),
  }).strict(),
  symbols: z.array(z.object({
    symbol: z.string().min(1),
    base: z.number().positive(),
    scenario: scenarioSchema,
  }).strict()).min(1),
}).strict();

type ChartCatalog = z.infer<typeof catalogSchema>;
type ChartScenario = z.infer<typeof scenarioSchema>;

export function loadSyntheticChartCatalog(): ChartCatalog {
  return catalogSchema.parse(catalogJson);
}

const fixturePolicyVersion: PolicyVersion = brandReference<string, "PolicyVersion">("policy:f2-fixture");

function availableSeries(
  selection: ChartSelection,
  series: ChartSeriesValue,
  asOfMs: number,
  nowMs: number,
  licenseScope: ChartCatalog["licenseScope"],
): AvailableInformation<ChartSeriesValue> {
  return {
    status: "available",
    value: series,
    evidenceReference: series.evidenceReference,
    provider: "synthetic",
    feed: `fixture-chart-${selection.range}-${selection.interval}`,
    venue: "SYNTHETIC",
    asOf: new Date(asOfMs).toISOString(),
    receivedAt: new Date(nowMs).toISOString(),
    freshness: "realtime",
    licenseScope,
    policyVersion: fixturePolicyVersion,
  };
}

function withMalformedTail(bars: readonly ChartBar[]): ChartBar[] {
  const copy = bars.map((bar) => ({ ...bar }));
  const last = copy.at(-1);
  if (last) last.close = Number.NaN;
  return copy;
}

/**
 * Fixture-backed FinancialInformation for charts. Any valid (symbol, range,
 * interval) resolves to a deterministically generated window sized by the
 * canonical calendar. Scenario symbols in the catalog exercise the freshness,
 * deadline, and invalid-response branches; every other symbol is a fresh series.
 */
export function createScriptedChartInformation(clock: ChartClock, catalog = loadSyntheticChartCatalog()): ChartInformation {
  const scenarioBySymbol = new Map<string, ChartScenario>(catalog.symbols.map((entry) => [entry.symbol, entry.scenario]));
  const baseBySymbol = new Map<string, number>(catalog.symbols.map((entry) => [entry.symbol, entry.base]));

  return {
    read(query: ChartQuery): ChartLoad {
      const selection: ChartSelection = { symbol: query.symbol, range: query.range, interval: query.interval };
      const scenario = scenarioBySymbol.get(query.symbol) ?? "fresh";
      const base = baseBySymbol.get(query.symbol) ?? 100 + (query.symbol.length % 7) * 10;
      const window = resolveChartWindow(query.range, query.interval);
      const intervalMs = intervalToMs(query.interval);
      const nowMs = clock.now();
      const meta = { intervalMs, declaredLagMs: 0, nowMs };

      // A live realtime feed's newest bar is the currently-forming interval (age 0); a stale
      // cache's newest bar started two intervals ago (inside the soft-expiry band).
      const staleScenario = scenario === "soft_expired" || scenario === "stale_error";
      const endPeriodStartMs = staleScenario ? nowMs - 2 * intervalMs : nowMs;

      let bars = synthesizeChartBars({ count: window.expectedBars, intervalMs, endPeriodStartMs, base });
      if (scenario === "future") {
        bars = [...bars, { ...bars[bars.length - 1]!, periodStart: new Date(nowMs + intervalMs).toISOString() }];
      } else if (scenario === "malformed") {
        bars = withMalformedTail(bars);
      }

      const series = buildChartSeries(selection, bars, chartEvidenceReference(selection));
      const asOfMs = Math.min(endPeriodStartMs + intervalMs, nowMs);
      const available = availableSeries(selection, series, asOfMs, nowMs, catalog.licenseScope);

      if (scenario === "stale_error") {
        // Refresh failed but the soft-expired cache is retainable: serve it stale (stale-if-error).
        const failed = chartTimeoutOutcome("synthetic", available.feed, new Date(nowMs).toISOString());
        return { kind: "FinancialLoad", cache: "hit", query, result: Promise.resolve(resolveWithStaleIfError(failed, available, meta)) };
      }

      const settle = (): InformationOutcome<ChartSeriesValue> => applyChartFreshness(available, meta);
      if (scenario === "never") {
        return { kind: "FinancialLoad", cache: "miss", query, result: new Promise<InformationOutcome<ChartSeriesValue>>(() => undefined) };
      }
      if (scenario === "slow_miss") {
        return { kind: "FinancialLoad", cache: "miss", query, result: clock.sleep(SLOW_MISS_SETTLE_MS).then(settle) };
      }
      return { kind: "FinancialLoad", cache: "hit", query, result: Promise.resolve(settle()) };
    },
    follow() {
      return emptyChartUpdates();
    },
  };
}

function emptyChartUpdates(): ReturnType<ChartInformation["follow"]> {
  return { async *[Symbol.asyncIterator]() { return; } };
}
