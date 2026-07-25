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
 * position sequencing exists here to drift. The tax disclosure (T9) shows the
 * gross-vs-net line: every headline figure is net of the sell transaction tax,
 * and grossTimeWeightedReturn/taxDrag make that cost visible instead of
 * silently folded in. If a backtest ever carries intermediate external flows,
 * relocate the F7 calculators to neutral ground and reuse them — the closed
 * forms below assume the no-flow shape.
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
 * A window-boundary portfolio value (seed / final), MAJOR units, coverage-typed.
 * Through the runner these are always a finite fold mark; a non-finite value
 * reaches here only by mis-calling buildPerformance directly, and it must never
 * serialize as a `null` masquerading as a declared number — the same honesty
 * invariant the tax block upholds. The single failure mode (a non-finite value)
 * is named `invalid_value` for shape parity with the return/tax unions. No
 * legitimate `unavailable` arises from the runner (equity marks are finite ints).
 */
export type WindowValue =
  | Readonly<{ status: "covered"; value: number }>
  | Readonly<{ status: "unavailable"; reason: "invalid_value" }>;

function windowValue(value: number): WindowValue {
  return Number.isFinite(value) ? { status: "covered", value } : { status: "unavailable", reason: "invalid_value" };
}

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

/**
 * T9 — what the transaction tax cost this run, the "gross vs net" line. Every
 * headline figure in the report is NET (the ledger charges tax on sell
 * proceeds); this block shows the same run WITHOUT the tax so the drag is
 * visible instead of silently folded in. `grossTimeWeightedReturn` adds the
 * tax paid back to the TERMINAL value — a first-order approximation that
 * assumes the saved tax would not have been reinvested (the true counterfactual
 * is path-dependent; this is the standard fee/tax-drag convention and is
 * disclosed as such). An untaxed run (costModel "none") has taxPaid 0 and a
 * covered zero drag — a fact, not a fabrication.
 */
export type TaxDisclosure =
  | Readonly<{
      status: "covered";
      /** Total sell transaction tax charged over the run, MAJOR units. */
      taxPaid: number;
      /** TWR with taxPaid added back to the terminal value (untaxed
       * counterfactual, no-reinvestment first-order). Compare with the net
       * timeWeightedReturn. May itself be unavailable (e.g. zero window)
       * while taxPaid — a window-independent ledger fact — stays reported. */
      grossTimeWeightedReturn: BacktestReturn;
      /** gross − net TWR, in return points (≥ 0). Covered only when both are. */
      taxDrag: BacktestReturn;
    }>
  /** The TOTAL itself is untrustworthy (non-finite, negative, or a float-
   * drifted sum past 2^53). The whole block goes unavailable so no
   * serializable field ever carries a non-finite number — NaN would silently
   * become JSON null and contradict the declared type (codex T9 MED/HIGH). */
  | Readonly<{ status: "unavailable"; reason: "invalid_total" }>;

export type BacktestPerformance = Readonly<{
  currency: string;
  /** Portfolio value at the first and last bar, MAJOR units (display),
   * coverage-typed so a non-finite value never serializes as a bare `null`. */
  seedValue: WindowValue;
  finalValue: WindowValue;
  /** Time-weighted (holding-period) return over [first bar, last bar]. */
  timeWeightedReturn: BacktestReturn;
  /** Money-weighted (XIRR) ANNUALIZED return: seed outflow → terminal inflow. */
  moneyWeightedReturn: BacktestReturn;
  /** Max peak-to-trough decline over the equity curve, ratio in [0, 1]. */
  maxDrawdown: number;
  fillConfidence: FillConfidence;
  /** Win rate over sell fills (net of tax, average-cost). See {@link WinRate}. */
  winRate: WinRate;
  /** Gross-vs-net disclosure (T9). See {@link TaxDisclosure}. */
  tax: TaxDisclosure;
}>;

/**
 * Max peak-to-trough decline over an equity curve. The ratio is unit-invariant,
 * so minor or major units both work. Returns 0 for fewer than two points or a
 * monotonically non-decreasing curve. A non-positive peak (bankruptcy — the
 * affordability guards forbid it in this engine) contributes no drawdown rather
 * than a meaningless division. A non-finite mark is skipped (matching
 * fillConfidence; the runner never emits one) so the result is always a finite
 * number, never a NaN/Infinity that would serialize to `null`. The [0, 1] range
 * assumes equity ≥ 0 — which the runner enforces (`invalid_bar_price`, and cash
 * never folds negative); a negative mark would push a >1 ratio, so callers off
 * the runner boundary owe that guarantee.
 */
export function maxDrawdown(equity: readonly number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const value of equity) {
    if (!Number.isFinite(value)) continue;
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

/**
 * T9 gross-vs-net line. The gross TWR reuses the SAME closed-form guards with
 * the tax added back to the terminal value. The drag is gross − net, which for
 * this shared-window closed form is algebraically exactly taxPaid/seed —
 * computed directly to avoid float cancellation between two near-equal ratios
 * (same class as the S4a TWR reformulation).
 */
function taxDisclosure(fromMs: number, toMs: number, seedValue: number, finalValue: number, net: BacktestReturn, taxPaid: number): TaxDisclosure {
  // The total is a sum of ledger-validated integer charges — negative or
  // non-finite means this is not the ledger's number (or the runner poisoned a
  // float-drifted sum); the WHOLE block refuses, keeping every serialized
  // field an honest finite number.
  if (!Number.isFinite(taxPaid) || taxPaid < 0) return { status: "unavailable", reason: "invalid_total" };
  const gross = closedFormReturns(fromMs, toMs, seedValue, finalValue + taxPaid).timeWeightedReturn;
  const taxDrag: BacktestReturn = gross.status === "covered" && net.status === "covered"
    ? { status: "covered", ratio: taxPaid / seedValue }
    : gross.status === "unavailable" ? gross : net;
  return { status: "covered", taxPaid, grossTimeWeightedReturn: gross, taxDrag };
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
  /** Total sell transaction tax charged over the run, MAJOR units (T9). */
  taxPaidValue: number;
}>): BacktestPerformance {
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  const { timeWeightedReturn, moneyWeightedReturn } = closedFormReturns(fromMs, toMs, input.seedValue, input.finalValue);
  return {
    currency: input.currency,
    seedValue: windowValue(input.seedValue),
    finalValue: windowValue(input.finalValue),
    timeWeightedReturn,
    moneyWeightedReturn,
    maxDrawdown: maxDrawdown(input.equity),
    fillConfidence: fillConfidence(input.participations),
    winRate: winRate(input.realizedSellsMinor),
    tax: taxDisclosure(fromMs, toMs, input.seedValue, input.finalValue, timeWeightedReturn, input.taxPaidValue),
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
  // A non-finite mark is skipped, so the result is always a finite number.
  assert(Number.isFinite(maxDrawdown([100, -Infinity])) && Number.isFinite(maxDrawdown([100, NaN, 90])), "non-finite mark → finite mdd");
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
    taxPaidValue: 0,
  });
  assert(perf.timeWeightedReturn.status === "covered"
    && Math.abs(perf.timeWeightedReturn.ratio - 0.21) < 1e-9, "twr 21%");
  assert(perf.moneyWeightedReturn.status === "covered"
    && Math.abs(perf.moneyWeightedReturn.ratio - 0.21) < 1e-9, "xirr 21%/yr over 365d");
  assert(Math.abs(perf.maxDrawdown - 0.2) < 1e-9, "mdd 20% (1.0M→0.8M)");
  // Boundary values are coverage-typed and covered for a finite run.
  assert(perf.seedValue.status === "covered" && perf.seedValue.value === 1_000_000
    && perf.finalValue.status === "covered" && perf.finalValue.value === 1_210_000, "boundary values covered");
  // Single-bar series: zero window → both returns unavailable, not fabricated.
  const flat = buildPerformance({
    currency: "KRW", from: "2024-01-01T00:00:00.000Z", to: "2024-01-01T00:00:00.000Z",
    seedValue: 1_000_000, finalValue: 1_000_000, equity: [1_000_000], participations: [], realizedSellsMinor: [],
    taxPaidValue: 0,
  });
  assert(flat.timeWeightedReturn.status === "unavailable" && flat.timeWeightedReturn.reason === "zero_window", "zero window → unavailable");
  assert(flat.moneyWeightedReturn.status === "unavailable", "zero window → xirr unavailable");
  // codex gate: non-finite / over-extrapolated inputs are unavailable, not a
  // fabricated null/Infinity/−1; a total loss is a covered −100% TWR.
  const year = { from: "2024-01-01T00:00:00.000Z", to: "2025-01-01T00:00:00.000Z" };
  const nanSeed = buildPerformance({ currency: "KRW", ...year, seedValue: NaN, finalValue: 100, equity: [100], participations: [], realizedSellsMinor: [], taxPaidValue: 0 });
  assert(nanSeed.timeWeightedReturn.status === "unavailable" && nanSeed.moneyWeightedReturn.status === "unavailable", "NaN seed → unavailable");
  // B-A: the echoed boundary value is coverage-typed too — a NaN seed is
  // `unavailable`, never a `null` masquerading as a declared number.
  assert(nanSeed.seedValue.status === "unavailable" && !JSON.stringify(nanSeed.seedValue).includes("null"), "NaN seed value → unavailable, never null");
  const tiny = buildPerformance({ currency: "KRW", from: "2024-01-01T00:00:00.000Z", to: "2024-01-01T00:01:00.000Z", seedValue: 100, finalValue: 101, equity: [100, 101], participations: [], realizedSellsMinor: [], taxPaidValue: 0 });
  assert(tiny.moneyWeightedReturn.status === "unavailable" && tiny.moneyWeightedReturn.reason === "unrepresentable", "tiny window → XIRR unrepresentable");
  const wipeout = buildPerformance({ currency: "KRW", ...year, seedValue: 100, finalValue: 0, equity: [100, 0], participations: [], realizedSellsMinor: [], taxPaidValue: 0 });
  assert(wipeout.timeWeightedReturn.status === "covered" && wipeout.timeWeightedReturn.ratio === -1, "total loss → TWR −100% covered");
  assert(wipeout.moneyWeightedReturn.status === "unavailable", "total loss → XIRR unavailable");
  assert(fillConfidence([Number.NaN, 0.1]).meanParticipation === 0.1, "non-finite participation sample skipped");
  // S4b win rate: per sell fill, break-even is not a win, no sells → unavailable.
  const wr = winRate([19_870, -10_110, 0]);
  assert(wr.status === "covered" && wr.sells === 3 && wr.wins === 1 && Math.abs(wr.ratio - 1 / 3) < 1e-12, "win rate 1/3");
  assert(winRate([]).status === "unavailable", "no sells → unavailable");
  const poisoned = winRate([Number.NaN]);
  assert(poisoned.status === "unavailable" && poisoned.reason === "invalid_sample", "non-finite sample → invalid_sample");
  // T9 tax disclosure: untaxed run has a covered ZERO drag (a fact); a taxed run's
  // gross adds the tax back to the terminal and drag = taxPaid/seed exactly.
  assert(perf.tax.status === "covered" && perf.tax.taxPaid === 0
    && perf.tax.taxDrag.status === "covered" && perf.tax.taxDrag.ratio === 0, "untaxed → zero drag");
  const taxed = buildPerformance({
    currency: "KRW", from: "2023-01-01T00:00:00.000Z", to: "2024-01-01T00:00:00.000Z",
    seedValue: 1_000_000, finalValue: 1_019_940, equity: [1_000_000, 1_019_940],
    participations: [], realizedSellsMinor: [19_940], taxPaidValue: 240,
  });
  assert(taxed.tax.status === "covered" && taxed.tax.grossTimeWeightedReturn.status === "covered"
    && Math.abs(taxed.tax.grossTimeWeightedReturn.ratio - 0.02018) < 1e-12, "gross TWR adds tax back");
  assert(taxed.tax.status === "covered" && taxed.tax.taxDrag.status === "covered" && taxed.tax.taxDrag.ratio === 0.00024, "drag = tax/seed");
  const badTax = buildPerformance({
    currency: "KRW", from: "2023-01-01T00:00:00.000Z", to: "2024-01-01T00:00:00.000Z",
    seedValue: 1_000_000, finalValue: 1_019_940, equity: [], participations: [], realizedSellsMinor: [], taxPaidValue: -1,
  });
  assert(badTax.tax.status === "unavailable" && badTax.tax.reason === "invalid_total", "invalid total → whole block unavailable");
  // codex T9 MED regression: no serialized field ever carries NaN → JSON null.
  const nanTax = buildPerformance({
    currency: "KRW", from: "2023-01-01T00:00:00.000Z", to: "2024-01-01T00:00:00.000Z",
    seedValue: 1_000_000, finalValue: 1_019_940, equity: [], participations: [], realizedSellsMinor: [], taxPaidValue: Number.NaN,
  });
  assert(!JSON.stringify(nanTax.tax).includes("null"), "NaN total never serializes as null");
}

if (process.argv[1]?.endsWith("performance-report.ts")) demo();
