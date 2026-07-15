import type {
  EvidenceReference,
  FinancialInformation,
  FinancialLoad,
  FinancialQuery,
  InformationOutcome,
  PolicyVersion,
} from "@/shared";
import type { GuestViewerContext } from "@/shared/contracts/viewer-context";

export const chartRanges = ["1D", "5D", "1M", "3M", "6M", "1Y", "2Y", "5Y"] as const;
export type ChartRange = (typeof chartRanges)[number];

export const chartIntervals = ["1m", "5m", "15m", "1h", "1D", "1W", "1Mo"] as const;
export type ChartInterval = (typeof chartIntervals)[number];

export type ChartSelection = Readonly<{
  symbol: string;
  range: ChartRange;
  interval: ChartInterval;
}>;

export interface ChartClock {
  now(): number;
  sleep(durationMs: number, signal?: AbortSignal): Promise<void>;
}

export type ChartPriceBasis = "raw" | "split_adjusted" | "total_return";

export type ChartBar = Readonly<{
  periodStart: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  priceBasis: ChartPriceBasis;
  complete: boolean;
}>;

export type ChartIndicatorBand = Readonly<{
  upper: readonly (number | null)[];
  middle: readonly (number | null)[];
  lower: readonly (number | null)[];
}>;

export type ChartMacdSeries = Readonly<{
  macd: readonly (number | null)[];
  signal: readonly (number | null)[];
  histogram: readonly (number | null)[];
}>;

export type ChartIndicators = Readonly<{
  policyVersion: PolicyVersion;
  movingAverage: readonly (number | null)[];
  bollinger: ChartIndicatorBand;
  rsi: readonly (number | null)[];
  macd: ChartMacdSeries;
}>;

export type ChartSummary = Readonly<{
  count: number;
  first: ChartBar | null;
  last: ChartBar | null;
  high: number | null;
  low: number | null;
}>;

export type ChartSeriesValue = Readonly<{
  symbol: string;
  range: ChartRange;
  interval: ChartInterval;
  priceBasis: ChartPriceBasis;
  bars: readonly ChartBar[];
  indicators: ChartIndicators;
  summary: ChartSummary;
  evidenceReference: EvidenceReference;
}>;

export type ChartRequestRevision = string;

export type ChartQuery = FinancialQuery & Readonly<{
  symbol: string;
  range: ChartRange;
  interval: ChartInterval;
  purpose: "chart_display";
  requestRevision: ChartRequestRevision;
}>;

export type ChartLoad = FinancialLoad & Readonly<{
  cache: "hit" | "miss";
  query: ChartQuery;
  result: Promise<InformationOutcome<ChartSeriesValue>>;
}>;

export interface ChartInformation extends FinancialInformation {
  read(query: ChartQuery, viewer: GuestViewerContext): ChartLoad;
}

export type ChartFixtureCase = Readonly<{
  id: string;
  symbol: string;
  range: ChartRange;
  interval: ChartInterval;
  cache: "hit" | "miss";
  settleAfterMs?: number | null;
  outcome: InformationOutcome<ChartSeriesValue>;
}>;

export type ChartFixtureCatalog = Readonly<{
  marker: "SYNTHETIC TEST DATA";
  provider: "synthetic";
  isSynthetic: true;
  cases: readonly ChartFixtureCase[];
}>;
