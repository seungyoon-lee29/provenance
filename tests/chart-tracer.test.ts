import { describe, expect, it } from "vitest";

import { createScriptedChartInformation } from "../src/modules/financial-information/chart/scripted-chart-information";
import type { ChartSelection } from "../src/modules/financial-information/chart/contracts";
import { createChartTracer } from "../src/modules/terminal-view/presentation/chart/chart-tracer";
import type { GuestViewerContext } from "@/shared/contracts/viewer-context";
import { ManualClock } from "./harness/manual-clock";

const NOW = Date.parse("2026-03-02T15:00:00.000Z");
const viewer: GuestViewerContext = { kind: "guest", requestId: "req" };
const sel = (symbol: string, range: ChartSelection["range"], interval: ChartSelection["interval"]): ChartSelection =>
  ({ symbol, range, interval });

function tracerAtNow() {
  const clock = new ManualClock();
  clock.advanceBy(NOW);
  const tracer = createChartTracer({ chartInformation: createScriptedChartInformation(clock), viewer, clock });
  return { clock, tracer };
}

describe("chart tracer (revision, latest-only, deadline)", () => {
  it("assigns monotonic revisions and paints the selected window", async () => {
    const { tracer } = tracerAtNow();
    const monthly = await tracer.select(sel("AAPL", "1M", "1D"));
    const yearly = await tracer.select(sel("AAPL", "1Y", "1W"));
    expect(monthly?.revision).toBe(1);
    expect(yearly?.revision).toBe(2);
    if (monthly?.outcome.status !== "available" || yearly?.outcome.status !== "available") throw new Error("expected available");
    expect(monthly.outcome.value.summary.count).toBe(22);
    expect(yearly.outcome.value.summary.count).toBe(52);
  });

  it("drops a stale out-of-order response so only the latest selection paints", async () => {
    const { clock, tracer } = tracerAtNow();
    const slow = tracer.select(sel("SLOW", "1M", "1D")); // revision 1, settles after 300ms
    const fast = tracer.select(sel("AAPL", "1Y", "1W")); // revision 2, cache hit
    const fastFrame = await fast;
    expect(fastFrame?.revision).toBe(2);
    clock.advanceBy(300);
    expect(await slow).toBeNull();
  });

  it("returns null for a request that a newer selection supersedes", async () => {
    const { clock, tracer } = tracerAtNow();
    const superseded = tracer.select(sel("TIMEOUT", "1M", "1D")); // revision 1, never settles
    const latest = await tracer.select(sel("MSFT", "1M", "1D")); // revision 2, cache hit
    expect(latest?.revision).toBe(2);
    clock.advanceBy(10_000); // fire the aborted deadline of the superseded request
    expect(await superseded).toBeNull();
  });

  it("normalizes an unanswered request to a timeout at the ten-second deadline", async () => {
    const { clock, tracer } = tracerAtNow();
    const pending = tracer.select(sel("TIMEOUT", "1M", "1D"));
    clock.advanceBy(10_000);
    const frame = await pending;
    expect(frame?.revision).toBe(1);
    expect(frame?.outcome).toMatchObject({ status: "failed", degradation: { code: "timeout", retryable: true } });
  });
});
