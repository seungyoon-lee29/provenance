import { describe, expect, it } from "vitest";

import { createScriptedChartInformation } from "../src/modules/financial-information/chart/scripted-chart-information";
import type { ChartQuery } from "../src/modules/financial-information/chart/contracts";
import { presentChartFrame } from "../src/modules/terminal-view/presentation/chart/chart-presenter";
import type { ChartFrame } from "../src/modules/terminal-view/presentation/chart/chart-tracer";
import { ManualClock } from "./harness/manual-clock";

const NOW = Date.parse("2026-03-02T15:00:00.000Z");
const viewer = { kind: "guest" as const, requestId: "req" };

function clockAtNow(): ManualClock {
  const clock = new ManualClock();
  clock.advanceBy(NOW);
  return clock;
}

async function frameFor(symbol: string): Promise<ChartFrame> {
  const chart = createScriptedChartInformation(clockAtNow());
  const q: ChartQuery = { kind: "FinancialQuery", symbol, range: "1M", interval: "1D", purpose: "chart_display", requestRevision: "1" };
  return { revision: 1, selection: { symbol, range: "1M", interval: "1D" }, outcome: await chart.read(q, viewer).result };
}

describe("chart presenter", () => {
  it("builds an accessible summary and metrics for an available chart", async () => {
    const view = presentChartFrame(await frameFor("AAPL"));
    expect(view.tone).toBe("available");
    expect(view.hasValue).toBe(true);
    expect(view.accessibleSummary).toContain("22개 봉");
    expect(view.accessibleSummary).toContain("첫 종가");
    expect(view.accessibleSummary).toContain("마지막 종가");
    expect(view.metrics.find((metric) => metric.label === "봉 수")?.value).toBe("22");
    expect(view.provenance.some((entry) => entry.label === "Evidence Reference")).toBe(true);
    expect(view.provenance.some((entry) => entry.label === "Price Basis")).toBe(true);
  });

  it("changes the summary when the window changes", async () => {
    const monthly = presentChartFrame(await frameFor("AAPL"));
    const chart = createScriptedChartInformation(clockAtNow());
    const yearlyOutcome = await chart.read(
      { kind: "FinancialQuery", symbol: "AAPL", range: "1Y", interval: "1W", purpose: "chart_display", requestRevision: "2" },
      viewer,
    ).result;
    const yearly = presentChartFrame({ revision: 2, selection: { symbol: "AAPL", range: "1Y", interval: "1W" }, outcome: yearlyOutcome });
    expect(yearly.accessibleSummary).toContain("52개 봉");
    expect(yearly.accessibleSummary).not.toBe(monthly.accessibleSummary);
  });

  it("presents a failed chart with no value", async () => {
    const view = presentChartFrame(await frameFor("FUTURE"));
    expect(view.tone).toBe("failed");
    expect(view.hasValue).toBe(false);
    expect(view.metrics).toHaveLength(0);
    expect(view.accessibleSummary).toContain("표시 가능한 값 없음");
  });

  it("distinguishes failure codes with per-code copy", () => {
    const selection = { symbol: "AAPL", range: "1M" as const, interval: "1D" as const };
    const failed = (code: "timeout" | "invalid_response") => presentChartFrame({
      revision: 1, selection,
      outcome: { status: "failed", degradation: { code, provider: "synthetic", feed: "f", occurredAt: "2026-03-02T15:00:00.000Z", retryable: code === "timeout", diagnosticReference: "d" as never }, policyVersion: "p" as never },
    });
    const timeout = failed("timeout");
    const invalid = failed("invalid_response");
    expect(timeout.statusLabel).toContain("공급자 응답 실패");
    expect(invalid.statusLabel).toContain("공급자 응답 오류");
    expect(timeout.statusLabel).not.toBe(invalid.statusLabel);
  });
});
