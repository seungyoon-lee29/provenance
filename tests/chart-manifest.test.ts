import { describe, expect, it } from "vitest";

import {
  chartWindowKey,
  chartWindowManifest,
  isValidChartWindow,
  resolveChartWindow,
} from "../src/modules/financial-information/chart/chart-manifest";

describe("chart range × interval manifest", () => {
  it("exposes exactly 21 unique range × interval windows", () => {
    expect(chartWindowManifest).toHaveLength(21);
    const keys = chartWindowManifest.map((window) => window.key);
    expect(new Set(keys).size).toBe(21);
  });

  it("resolves the two spec-anchored windows to their golden bar counts", () => {
    // Independent oracle: AT-02 fixes 1M/1D → 22 bars and 1Y/1W → 52 bars.
    expect(resolveChartWindow("1M", "1D").expectedBars).toBe(22);
    expect(resolveChartWindow("1Y", "1W").expectedBars).toBe(52);
  });

  it("sizes intraday windows from the 390-minute canonical session", () => {
    // 1D range = 1 trading day. ceil(390/5)=78 five-minute bars, ceil(390/60)=7 hourly bars.
    expect(resolveChartWindow("1D", "5m").expectedBars).toBe(78);
    expect(resolveChartWindow("1D", "1h").expectedBars).toBe(7);
    // 5D range = 5 trading days × 26 fifteen-minute bars per session.
    expect(resolveChartWindow("5D", "15m").expectedBars).toBe(130);
  });

  it("sizes weekly and monthly windows from calendar periods", () => {
    expect(resolveChartWindow("3M", "1W").expectedBars).toBe(13);
    expect(resolveChartWindow("5Y", "1Mo").expectedBars).toBe(60);
  });

  it("rejects unsupported windows and every manifest entry validates", () => {
    expect(isValidChartWindow("1D", "1W")).toBe(false);
    expect(() => resolveChartWindow("1D", "1W")).toThrow();
    for (const window of chartWindowManifest) {
      expect(isValidChartWindow(window.range, window.interval)).toBe(true);
      expect(window.key).toBe(chartWindowKey(window.range, window.interval));
      expect(window.expectedBars).toBeGreaterThan(0);
    }
  });
});
