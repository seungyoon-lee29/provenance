import { chartTimeoutOutcome } from "../../../financial-information/chart/chart-freshness";
import type {
  ChartClock,
  ChartInformation,
  ChartQuery,
  ChartSelection,
  ChartSeriesValue,
} from "../../../financial-information/chart/contracts";
import type { GuestViewerContext } from "@/shared/contracts/viewer-context";
import type { InformationOutcome } from "@/shared";

export const CHART_DEADLINE_AFTER_MS = 10_000;

export const chartSystemClock: ChartClock = {
  now: () => Date.now(),
  sleep(durationMs, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("chart request cancelled"));
        return;
      }
      const timer = setTimeout(resolve, durationMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("chart request cancelled"));
      }, { once: true });
    });
  },
};

export type ChartFrame = Readonly<{
  revision: number;
  selection: ChartSelection;
  outcome: InformationOutcome<ChartSeriesValue>;
}>;

function chartQuery(selection: ChartSelection, revision: number): ChartQuery {
  return {
    kind: "FinancialQuery",
    symbol: selection.symbol,
    range: selection.range,
    interval: selection.interval,
    purpose: "chart_display",
    requestRevision: String(revision),
  };
}

/**
 * Stateful chart tracer. Each `select` takes the next monotonic revision,
 * cancels the prior in-flight request, and races the read against a 10s
 * deadline. A frame is returned only if its revision is still the latest, so a
 * stale, cancelled, or out-of-order response resolves to `null` and never
 * paints (WS-05 / AT-02).
 */
export function createChartTracer(options: Readonly<{
  chartInformation: ChartInformation;
  viewer: GuestViewerContext;
  clock?: ChartClock;
  deadlineMs?: number;
}>) {
  const clock = options.clock ?? chartSystemClock;
  const deadlineMs = options.deadlineMs ?? CHART_DEADLINE_AFTER_MS;
  let revisionCounter = 0;
  let controller: AbortController | null = null;

  async function select(selection: ChartSelection): Promise<ChartFrame | null> {
    const revision = (revisionCounter += 1);
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const load = options.chartInformation.read(chartQuery(selection, revision), options.viewer);
    const deadline = clock.sleep(deadlineMs, current.signal);
    const raced = await Promise.race([
      load.result.then((value) => ({ tag: "result" as const, value })),
      deadline.then(() => ({ tag: "deadline" as const })).catch(() => ({ tag: "aborted" as const })),
    ]);
    current.abort();
    if (raced.tag === "aborted") return null;
    if (revision !== revisionCounter) return null;
    const outcome: InformationOutcome<ChartSeriesValue> = raced.tag === "result"
      ? raced.value
      : chartTimeoutOutcome("synthetic", `chart-${selection.range}-${selection.interval}`, new Date(clock.now()).toISOString());
    return { revision, selection, outcome };
  }

  return { select, get revision() { return revisionCounter; } };
}

/** One-shot frame read for SSR initial paint (default selection, revision 0). */
export async function readInitialChartFrame(
  chartInformation: ChartInformation,
  viewer: GuestViewerContext,
  selection: ChartSelection,
): Promise<ChartFrame> {
  const load = chartInformation.read(chartQuery(selection, 0), viewer);
  return { revision: 0, selection, outcome: await load.result };
}
