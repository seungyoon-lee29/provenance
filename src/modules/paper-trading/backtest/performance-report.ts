/**
 * T8 S4 — backtest performance report (v1, slice S4a). A READ-ONLY aggregation
 * over what the fill engine already produced: it never mutates the ledger, it
 * only reads the per-bar folded state the runner hands it. Wrong numbers here
 * would mislead an investment judgment, so it stays coverage-typed — a metric
 * that cannot be honestly computed is `unavailable` with a reason, never a
 * fabricated figure ("값을 모르면 지어내지 않는다").
 *
 * TWR and money-weighted (XIRR) return are the CLOSED FORMS for a backtest's
 * shape: a single seed deposit and a terminal valuation, no external flows
 * crossing the window in between. With zero intermediate flows the general F7
 * calculators (linked sub-periods / Descartes-bracketed solver) collapse to
 *   TWR  = final/seed − 1               (one sub-period)
 *   XIRR = (final/seed)^(1/years) − 1   (two cashflows → unique closed root)
 * so they are computed inline here rather than importing across the Actual↔Paper
 * ledger isolation boundary (actual-paper-isolation.property.test). Win rate
 * (S4b) reads the fold's per-sell realized P&L (journal `realizedSales`) — the
 * fold computes it where the average-cost relief already is, so no mirror of
 * position sequencing exists here to drift. If a backtest ever carries
 * intermediate external flows, relocate the F7 calculators to neutral ground and
 * reuse them — the closed forms below assume the no-flow shape.
 */

/** Days per year for the XIRR day-count — matches the F7 solver's convention so
 * the annualized rate means the same thing (leap years count as 366/365). */
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/**
 * A backtest return, coverage-typed. `ratio` is the total holding-period return
 * for TWR and the annualized rate for the money-weighted figure. Uncomputable
 * inputs (a zero-width window, a non-positive seed/terminal, an unparseable
 * instant) yield `unavailable` with a reason — never a fabricated number.
 */
export type BacktestReturn =
  | Readonly<{ status: "covered"; ratio: number }>
  | Readonly<{ status: "unavailable"; reason: "zero_window" | "invalid_valuation" | "invalid_timestamp" | "unrepresentable" }>;

/**
 * How much of the simulation leaned on the candle approximation. Decision 7
 * ("주문량 / 호가잔량") has no order-book depth to key on in candle mode, so the
 * honest proxy is participation = filled quantity / that bar's traded volume.
 * The simulator caps cumulative participation at 10% per observation, so that is
 * the ceiling: the closer to it, the more heroic the "fills at ~close" premise.
 */
export type FillConfidence = Readonly<{
  /** Number of fills that contributed a participation sample. */
  fills: number;
  /** Largest single-fill participation (share of a bar's volume). 0 if no fills. */
  maxParticipation: number;
  /** Mean participation across fills. 0 if no fills. */
  meanParticipation: number;
}>;

/**
 * Win rate over SELL FILLS (S4b) — the natural unit of average-cost relief, not
 * round trips. A win is realized P&L (net of transaction tax) strictly > 0;
 * break-even is not a win. Zero sells is `no_sells` unavailable — a
 * buy-and-hold strategy has no win rate, and a fabricated 0% would read as
 * "always lost". A non-finite sample cannot come from the integer fold, so it
 * marks the whole figure `invalid_sample` — unlike fillConfidence's skip: a
 * dropped confidence sample stays visible in its `fills` count (diagnostic),
 * but a dropped sell would silently shift this headline ratio.
 */
export type WinRate =
  | Readonly<{ status: "covered"; sells: number; wins: number; ratio: number }>
  | Readonly<{ status: "unavailable"; reason: "no_sells" | "invalid_sample" }>;

export function winRate(realizedSellsMinor: readonly number[]): WinRate {
  if (realizedSellsMinor.length === 0) return { status: "unavailable", reason: "no_sells" };
  if (realizedSellsMinor.some((minor) => !Number.isFinite(minor))) return { status: "unavailable", reason: "invalid_sample" };
  const wins = realizedSellsMinor.filter((minor) => minor > 0).length;
  return { status: "covered", sells: realizedSellsMinor.length, wins, ratio: wins / realizedSellsMinor.length };
}

export type BacktestPerformance = Readonly<{
  currency: string;
  /** Portfolio value at the first and last bar, in MAJOR units (display). */
  seedValue: number;
  finalValue: number;
  /** Time-weighted (holding-period) return over [first bar, last bar]. */
  timeWeightedReturn: BacktestReturn;
  /** Money-weighted (XIRR) ANNUALIZED return: seed outflow → terminal inflow. */
  moneyWeightedReturn: BacktestReturn;
  /** Max peak-to-trough decline over the equity curve, ratio in [0, 1]. */
  maxDrawdown: number;
  fillConfidence: FillConfidence;
  /** Win rate over sell fills (net of tax, average-cost). See {@link WinRate}. */
  winRate: WinRate;
}>;

/**
 * Max peak-to-trough decline over an equity curve. The ratio is unit-invariant,
 * so minor or major units both work. Returns 0 for fewer than two points or a
 * monotonically non-decreasing curve. A non-positive peak (bankruptcy — the
 * affordability guards forbid it in this engine) contributes no drawdown rather
 * than a meaningless division.
 */
export function maxDrawdown(equity: readonly number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const drawdown = (peak - value) / peak;
      if (drawdown > mdd) mdd = drawdown;
    }
  }
  return mdd;
}

export function fillConfidence(participations: readonly number[]): FillConfidence {
  let max = 0;
  let sum = 0;
  let fills = 0;
  for (const participation of participations) {
    // A non-finite sample is an invalid measurement — skip it rather than let it
    // poison the mean to NaN (codex gate; the runner never produces one).
    if (!Number.isFinite(participation)) continue;
    if (participation > max) max = participation;
    sum += participation;
    fills += 1;
  }
  return { fills, maxParticipation: max, meanParticipation: fills === 0 ? 0 : sum / fills };
}

/**
 * TWR (no external flows) and XIRR (two cashflows) closed forms. They share the
 * window/seed guard but split on the terminal: a total loss (final = 0) is a
 * covered −100% TWR, yet leaves XIRR with only one flow and no root
 * (unavailable). A rate that annualizes to a non-finite magnitude or to the
 * excluded r = −1 boundary — a sub-day window over-extrapolated — is
 * `unrepresentable`, not a fabricated Infinity/−1 (codex gate).
 */
function closedFormReturns(fromMs: number, toMs: number, seedValue: number, finalValue: number): {
  timeWeightedReturn: BacktestReturn;
  moneyWeightedReturn: BacktestReturn;
} {
  const both = (result: BacktestReturn) => ({ timeWeightedReturn: result, moneyWeightedReturn: result });
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return both({ status: "unavailable", reason: "invalid_timestamp" });
  if (toMs <= fromMs) return both({ status: "unavailable", reason: "zero_window" });
  // Seed must be a finite positive base; terminal must be finite and ≥ 0 (0 is a
  // real total loss). A non-finite either side has no honest ratio.
  if (!Number.isFinite(seedValue) || seedValue <= 0 || !Number.isFinite(finalValue) || finalValue < 0) {
    return both({ status: "unavailable", reason: "invalid_valuation" });
  }
  // TWR: (final − seed)/seed avoids catastrophic cancellation near final ≈ seed;
  // final = 0 ⇒ −1 (−100%), a covered fact.
  const twrRatio = (finalValue - seedValue) / seedValue;
  const timeWeightedReturn: BacktestReturn = Number.isFinite(twrRatio)
    ? { status: "covered", ratio: twrRatio }
    : { status: "unavailable", reason: "invalid_valuation" };
  // XIRR: the single root of −seed + final·(1+r)^(−years) = 0 is
  // (final/seed)^(1/years) − 1. final = 0 leaves one flow (no root); an
  // over-extrapolated tiny window overflows to ±∞ or the excluded r = −1.
  let moneyWeightedReturn: BacktestReturn;
  if (finalValue <= 0) {
    moneyWeightedReturn = { status: "unavailable", reason: "invalid_valuation" };
  } else {
    const years = (toMs - fromMs) / MS_PER_YEAR;
    const rate = (finalValue / seedValue) ** (1 / years) - 1;
    moneyWeightedReturn = Number.isFinite(rate) && rate > -1
      ? { status: "covered", ratio: rate }
      : { status: "unavailable", reason: "unrepresentable" };
  }
  return { timeWeightedReturn, moneyWeightedReturn };
}

export function buildPerformance(input: Readonly<{
  currency: string;
  /** First and last bar instants (ISO, tz-qualified, real-calendar) — the return
   * window. The runner validates these before calling; unparseable ones still
   * fail closed here to `invalid_timestamp`. */
  from: string;
  to: string;
  /** Portfolio value at the window boundaries, in MAJOR units. */
  seedValue: number;
  finalValue: number;
  /** Per-bar equity for the drawdown curve (any consistent unit). */
  equity: readonly number[];
  /** Per-fill participation samples (filled quantity / bar volume). */
  participations: readonly number[];
  /** Per-sell realized P&L in integer minor units (the fold's `realizedSales`). */
  realizedSellsMinor: readonly number[];
}>): BacktestPerformance {
  const { timeWeightedReturn, moneyWeightedReturn } = closedFormReturns(
    Date.parse(input.from),
    Date.parse(input.to),
    input.seedValue,
    input.finalValue,
  );
  return {
    currency: input.currency,
    seedValue: input.seedValue,
    finalValue: input.finalValue,
    timeWeightedReturn,
    moneyWeightedReturn,
    maxDrawdown: maxDrawdown(input.equity),
    fillConfidence: fillConfidence(input.participations),
    winRate: winRate(input.realizedSellsMinor),
  };
}

function demo(): void {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`performance-report demo: ${msg}`);
  };
  // MDD: peak 120 then trough 90 → (120−90)/120 = 0.25.
  assert(maxDrawdown([100, 120, 90, 110]) === 0.25, "mdd 25%");
  assert(maxDrawdown([100, 110, 130]) === 0, "monotonic up → 0");
  assert(maxDrawdown([]) === 0 && maxDrawdown([100]) === 0, "degenerate → 0");
  // Confidence.
  const c = fillConfidence([0.05, 0.1, 0.03]);
  assert(c.fills === 3 && c.maxParticipation === 0.1 && Math.abs(c.meanParticipation - 0.06) < 1e-9, "confidence agg");
  assert(fillConfidence([]).maxParticipation === 0, "no fills → 0");
  // E2E: 1,000,000 → 1,210,000 over exactly 365 days (2023 non-leap → t = 1.0,
  // so annualized XIRR is exactly 21%; a leap window would be ~20.94% — correct).
  const perf = buildPerformance({
    currency: "KRW",
    from: "2023-01-01T00:00:00.000Z",
    to: "2024-01-01T00:00:00.000Z",
    seedValue: 1_000_000,
    finalValue: 1_210_000,
    equity: [1_000_000, 800_000, 1_210_000],
    participations: [0.1],
    realizedSellsMinor: [],
  });
  assert(perf.timeWeightedReturn.status === "covered"
    && Math.abs(perf.timeWeightedReturn.ratio - 0.21) < 1e-9, "twr 21%");
  assert(perf.moneyWeightedReturn.status === "covered"
    && Math.abs(perf.moneyWeightedReturn.ratio - 0.21) < 1e-9, "xirr 21%/yr over 365d");
  assert(Math.abs(perf.maxDrawdown - 0.2) < 1e-9, "mdd 20% (1.0M→0.8M)");
  // Single-bar series: zero window → both returns unavailable, not fabricated.
  const flat = buildPerformance({
    currency: "KRW", from: "2024-01-01T00:00:00.000Z", to: "2024-01-01T00:00:00.000Z",
    seedValue: 1_000_000, finalValue: 1_000_000, equity: [1_000_000], participations: [], realizedSellsMinor: [],
  });
  assert(flat.timeWeightedReturn.status === "unavailable" && flat.timeWeightedReturn.reason === "zero_window", "zero window → unavailable");
  assert(flat.moneyWeightedReturn.status === "unavailable", "zero window → xirr unavailable");
  // codex gate: non-finite / over-extrapolated inputs are unavailable, not a
  // fabricated null/Infinity/−1; a total loss is a covered −100% TWR.
  const year = { from: "2024-01-01T00:00:00.000Z", to: "2025-01-01T00:00:00.000Z" };
  const nanSeed = buildPerformance({ currency: "KRW", ...year, seedValue: NaN, finalValue: 100, equity: [100], participations: [], realizedSellsMinor: [] });
  assert(nanSeed.timeWeightedReturn.status === "unavailable" && nanSeed.moneyWeightedReturn.status === "unavailable", "NaN seed → unavailable");
  const tiny = buildPerformance({ currency: "KRW", from: "2024-01-01T00:00:00.000Z", to: "2024-01-01T00:01:00.000Z", seedValue: 100, finalValue: 101, equity: [100, 101], participations: [], realizedSellsMinor: [] });
  assert(tiny.moneyWeightedReturn.status === "unavailable" && tiny.moneyWeightedReturn.reason === "unrepresentable", "tiny window → XIRR unrepresentable");
  const wipeout = buildPerformance({ currency: "KRW", ...year, seedValue: 100, finalValue: 0, equity: [100, 0], participations: [], realizedSellsMinor: [] });
  assert(wipeout.timeWeightedReturn.status === "covered" && wipeout.timeWeightedReturn.ratio === -1, "total loss → TWR −100% covered");
  assert(wipeout.moneyWeightedReturn.status === "unavailable", "total loss → XIRR unavailable");
  assert(fillConfidence([Number.NaN, 0.1]).meanParticipation === 0.1, "non-finite participation sample skipped");
  // S4b win rate: per sell fill, break-even is not a win, no sells → unavailable.
  const wr = winRate([19_870, -10_110, 0]);
  assert(wr.status === "covered" && wr.sells === 3 && wr.wins === 1 && Math.abs(wr.ratio - 1 / 3) < 1e-12, "win rate 1/3");
  assert(winRate([]).status === "unavailable", "no sells → unavailable");
  const poisoned = winRate([Number.NaN]);
  assert(poisoned.status === "unavailable" && poisoned.reason === "invalid_sample", "non-finite sample → invalid_sample");
}

if (process.argv[1]?.endsWith("performance-report.ts")) demo();
