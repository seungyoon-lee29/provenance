import { describe, expect, it } from "vitest";

import { createScriptedChartInformation } from "../src/modules/financial-information/chart/scripted-chart-information";
import type { ChartInterval, ChartQuery, ChartRange } from "../src/modules/financial-information/chart/contracts";
import { ManualClock } from "./harness/manual-clock";

const NOW = Date.parse("2026-03-02T15:00:00.000Z");

function query(symbol: string, range: ChartRange, interval: ChartInterval, revision = "r1"): ChartQuery {
  return { kind: "FinancialQuery", symbol, range, interval, purpose: "chart_display", requestRevision: revision };
}

function clockAtNow(): ManualClock {
  const clock = new ManualClock();
  clock.advanceBy(NOW);
  return clock;
}

describe("scripted chart information", () => {
  it("returns the golden 22-bar window for 1M/1D and 52-bar for 1Y/1W", async () => {
    const chart = createScriptedChartInformation(clockAtNow());
    const monthly = await chart.read(query("AAPL", "1M", "1D"), { kind: "guest", requestId: "req" }).result;
    const yearly = await chart.read(query("AAPL", "1Y", "1W"), { kind: "guest", requestId: "req" }).result;
    expect(monthly.status).toBe("available");
    if (monthly.status !== "available") throw new Error("expected available");
    expect(monthly.value.bars).toHaveLength(22);
    expect(monthly.value.summary.count).toBe(22);
    expect(monthly.freshness).toBe("realtime");
    expect(monthly.value.indicators.movingAverage).toHaveLength(22);
    if (yearly.status !== "available") throw new Error("expected available");
    expect(yearly.value.bars).toHaveLength(52);
  });

  it("produces a varying, deterministic series so a selection change is observable", async () => {
    const chart = createScriptedChartInformation(clockAtNow());
    const first = await chart.read(query("AAPL", "1M", "1D"), { kind: "guest", requestId: "req" }).result;
    const repeat = await chart.read(query("AAPL", "1M", "1D"), { kind: "guest", requestId: "req" }).result;
    if (first.status !== "available" || repeat.status !== "available") throw new Error("expected available");
    expect(repeat.value.bars).toEqual(first.value.bars);
    expect(first.value.summary.first!.close).not.toBe(first.value.summary.last!.close);
  });

  it("marks the STALE scenario available + stale with a degradation", async () => {
    const chart = createScriptedChartInformation(clockAtNow());
    const outcome = await chart.read(query("STALE", "1M", "1D"), { kind: "guest", requestId: "req" }).result;
    expect(outcome).toMatchObject({ status: "available", freshness: "stale", degradation: { retryable: true } });
  });

  it("serves a retained stale cache on a failed refresh (stale-if-error)", async () => {
    const chart = createScriptedChartInformation(clockAtNow());
    const outcome = await chart.read(query("STALE_ERROR", "1M", "1D"), { kind: "guest", requestId: "req" }).result;
    expect(outcome).toMatchObject({ status: "available", freshness: "stale", degradation: { retryable: true } });
    if (outcome.status !== "available") throw new Error("expected available");
    expect(outcome.value.bars.length).toBeGreaterThan(0);
  });

  it("quarantines FUTURE and BROKEN scenarios as invalid_response with no value", async () => {
    const chart = createScriptedChartInformation(clockAtNow());
    const future = await chart.read(query("FUTURE", "1M", "1D"), { kind: "guest", requestId: "req" }).result;
    const broken = await chart.read(query("BROKEN", "1M", "1D"), { kind: "guest", requestId: "req" }).result;
    expect(future).toMatchObject({ status: "failed", degradation: { code: "invalid_response" } });
    expect(broken).toMatchObject({ status: "failed", degradation: { code: "invalid_response" } });
    expect("value" in future && future.value).toBeFalsy();
  });

  it("keeps the TIMEOUT scenario a never-settling cache miss", async () => {
    const chart = createScriptedChartInformation(clockAtNow());
    const load = chart.read(query("TIMEOUT", "1M", "1D"), { kind: "guest", requestId: "req" });
    expect(load.cache).toBe("miss");
    const settled = await Promise.race([load.result.then(() => "settled"), Promise.resolve("pending")]);
    expect(settled).toBe("pending");
  });

  it("settles the SLOW scenario only after its miss delay elapses", async () => {
    const clock = clockAtNow();
    const chart = createScriptedChartInformation(clock);
    const load = chart.read(query("SLOW", "1M", "1D"), { kind: "guest", requestId: "req" });
    expect(load.cache).toBe("miss");
    clock.advanceBy(300);
    const outcome = await load.result;
    expect(outcome.status).toBe("available");
  });
});
