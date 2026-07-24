import { brandReference } from "../../../shared/contracts/brands";
import type { PaperOrderReference } from "../../../shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";

import { currencyMinorUnitScale, fromMinorUnits, grossMinorOf } from "../internal/contracts";
import type { KrxTaxClass } from "../internal/contracts";
import { KRX_TAX_POLICY_VERSION, isSupportedTaxDate } from "../internal/krx-transaction-tax";
import { buildPerformance } from "./performance-report";
import type { BacktestPerformance } from "./performance-report";
import type {
  PaperCashRow,
  PaperMarketObservation,
  PaperMoney,
  PaperOrderPayload,
  PaperOrderView,
  PaperPositionRow,
} from "../internal/contracts";
import { PaperTradingService, presentState } from "../internal/service";
import { InternalPaperSimulator, SIMULATION_V1 } from "../internal/simulator";

/**
 * T8 S1 — backtest runner: the SAME fill engine (InternalPaperSimulator +
 * PaperJournal via PaperTradingService), driven by historical bars instead of
 * a live feed (pivot §3 decision 6: one engine, only the observation source
 * differs). The runner deliberately goes through the real product seam
 * (prepare → change) rather than appending journal entries directly, so order
 * acceptance — affordability, reservations, §8 receipts, intent one-time-ness
 * — is the production logic, not a backtest re-implementation (the F8
 * post-review's duplicated-money-logic drift is exactly what that would be).
 *
 * Look-ahead is blocked through the strategy's INTERFACE, not absolutely:
 * - Fills: the engine refuses `eventTime/dataClock <= acceptedAt` (simulator
 *   §9), so an order accepted at bar N's close can only fill from bar N+1 on —
 *   close-accept/next-bar-fill falls out of the invariant.
 * - Strategy view: `StrategyView.bar()` throws past the cursor, and the view's
 *   money objects are cloned, so the strategy can neither read future bars nor
 *   mutate the ledger through what it is handed.
 * A strategy that captures external data in its own scope (e.g. the raw series
 * in a same-scope closure) can still peek ahead — that is inherent to running
 * user strategy code, as in Zipline/Backtrader/Lean. The CLI is the real
 * containment: a strategy loaded there is a separate module with no reference
 * to the series, so the closure path does not exist on the product surface.
 * `periodStart` is used as the decision/availability instant; it labels the
 * period START (ChartBar has no interval), which preserves ordering but is an
 * approximation of when the close became knowable.
 *
 * Determinism: the ENGINE is deterministic — the clock is the bar cursor (no
 * wall clock), ids derive from (runId, barIndex, actionIndex), the journal is
 * the in-memory store. Reproducibility therefore holds for a PURE strategy; a
 * strategy carrying its own mutable state is itself part of what varies.
 */

/** Minimal bar contract — structurally satisfied by F2's `ChartBar`. */
export type BacktestBar = Readonly<{
  /** ISO instant identifying the bar (strictly increasing across the series). */
  periodStart: string;
  close: number;
  volume: number;
  /** Incomplete bars are refused up front — filling on one is look-ahead. */
  complete: boolean;
}>;

export type BacktestSeries = Readonly<{
  /** Paper instrument key, e.g. "instr:005930". Single-instrument v1. */
  instrument: string;
  venue: string;
  currency: string;
  /**
   * How the bar closes are adjusted (F2 `ChartPriceBasis`). Default "raw".
   * The engine executes bars as literal tradable prices, so a `total_return`
   * series (dividends folded into price) would fabricate fills at prices that
   * never traded — refused up front, mirroring the ledger's §8 total_return
   * rejection. The chosen basis is disclosed in the report (data honesty).
   */
  priceBasis?: "raw" | "split_adjusted" | "total_return";
  /** Korean transaction-tax class for this instrument (T8 S3). Undefined ⇒ an
   * untaxed simulation (disclosed as costModel "none"). Tax hits sells only. */
  taxClass?: KrxTaxClass;
  bars: readonly BacktestBar[];
}>;

/** What a strategy may order — instrument/venue/session come from the series,
 * so a strategy can never order outside the replayed instrument. */
export type StrategyOrder = Readonly<{
  side: "buy" | "sell";
  orderType: "market" | "limit";
  limitPrice?: PaperMoney;
  quantity: number;
  timeInForce: "DAY" | "GTC";
}>;

export type StrategyAction =
  | Readonly<{ kind: "submit"; order: StrategyOrder }>
  | Readonly<{ kind: "cancel"; order: PaperOrderReference }>;

export type StrategyView = Readonly<{
  /** Index of the just-closed bar. The strategy decides AT this close. */
  cursor: number;
  /** bars[index] for index ≤ cursor; RangeError past the cursor (look-ahead). */
  bar(index: number): BacktestBar;
  cash: readonly PaperCashRow[];
  positions: readonly PaperPositionRow[];
  orders: readonly PaperOrderView[];
}>;

export type BacktestStrategy = (view: StrategyView) => readonly StrategyAction[];

export type BacktestConfig = Readonly<{
  runId: string;
  seedCash: readonly PaperMoney[];
  series: BacktestSeries;
  strategy: BacktestStrategy;
}>;

/** A refused strategy action is a backtest FACT (recorded), not a crash. */
export type BacktestRefusal = Readonly<{
  barIndex: number;
  action: "submit" | "cancel";
  status: string;
}>;

export type BacktestReport = Readonly<{
  status: "complete";
  /** Candle-approximation mode (pivot §3 decision 6) — orderbook-precise mode is T12. */
  mode: "approximate";
  /** Disclosed input price basis (data honesty — adjusted closes are not raw). */
  priceBasis: "raw" | "split_adjusted";
  /** Disclosed transaction-cost model: the tax policy version, or "none" when
   * the series declared no taxClass (untaxed simulation). */
  costModel: string;
  policyVersion: string;
  runId: string;
  barCount: number;
  fillCount: number;
  expiryCount: number;
  refusals: readonly BacktestRefusal[];
  cash: readonly PaperCashRow[];
  positions: readonly PaperPositionRow[];
  orders: readonly PaperOrderView[];
  /** T8 S4 — read-only performance aggregation (TWR/XIRR reuse + MDD + fill
   * confidence). Each return is coverage-typed: uncomputable ⇒ unavailable. */
  performance: BacktestPerformance;
}>;

export type BacktestOutcome =
  | BacktestReport
  | Readonly<{
      status: "refused";
      reason:
        | "empty_series"
        | "incomplete_bar"
        | "invalid_bar_time"
        | "non_monotonic_series"
        | "no_seed_cash"
        | "invalid_seed_cash"
        | "unsupported_price_basis"
        | "invalid_strategy_result"
        | "tax_class_currency_mismatch"
        | "unsupported_tax_year"
        | "invalid_bar_price"
        | "seed_currency_mismatch";
    }>;

/** True when `amount` is a positive, finite whole number of the currency's
 * minor units — the only seed the integer ledger can hold without silent
 * rounding (codex gate: -1 / NaN / Infinity / sub-unit seeds folded into
 * broken balances). */
function isRepresentableCash(money: PaperMoney): boolean {
  return (
    Number.isFinite(money.amount)
    && money.amount > 0
    && Number.isInteger(money.amount * currencyMinorUnitScale(money.currency))
  );
}

/** The status string a refused prepare/change outcome contributes to the
 * report — the typed `reason` when refused, else the raw status. */
function refusalStatus(outcome: Readonly<{ status: string; reason?: string }>): string {
  return outcome.status === "refused" && outcome.reason !== undefined ? outcome.reason : outcome.status;
}

/** An ISO instant carries a timezone iff its time part ends in Z or ±hh:mm —
 * otherwise Date.parse reads it as local time (environment-dependent). */
function hasTimezone(iso: string): boolean {
  return /T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(iso);
}

/** Reject an instant whose calendar date does not round-trip: JS silently
 * normalizes an impossible date (2024-02-30 → 2024-03-01), and a normalized
 * wrong date is a fabrication, not an honest instant (codex gate). */
function isCalendarDate(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function observationOf(series: BacktestSeries, bar: BacktestBar): PaperMarketObservation {
  return {
    instrument: brandReference<string, "PaperInstrumentReference">(series.instrument),
    venue: series.venue,
    session: "regular",
    price: { amount: bar.close, currency: series.currency },
    volume: bar.volume,
    eventTime: bar.periodStart,
    receivedAt: bar.periodStart,
    dataClock: bar.periodStart,
    // Freshness is relative to the run's SIMULATED clock (now == eventTime ==
    // dataClock), where this bar is zero-age — "realtime" in that frame is the
    // honest label, and it is what reservation bounding requires
    // (service #reservationUnitPrice accepts realtime|delayed only). Provenance
    // stays explicit via the backtest evidence prefix and report mode.
    freshness: "realtime",
    evidenceReference: `backtest:${series.instrument}:${bar.periodStart}`,
    ...(series.taxClass !== undefined ? { taxClass: series.taxClass } : {}),
  };
}

export async function runBacktest(config: BacktestConfig): Promise<BacktestOutcome> {
  const { series, strategy } = config;
  // A total_return series would execute dividend-inflated prices as if they
  // traded — refuse it (spec §8), and disclose the surviving basis.
  const priceBasis = series.priceBasis ?? "raw";
  if (priceBasis === "total_return") return { status: "refused", reason: "unsupported_price_basis" };
  if (series.bars.length === 0) return { status: "refused", reason: "empty_series" };
  if (config.seedCash.length === 0) return { status: "refused", reason: "no_seed_cash" };
  // Seed cash reaches the money ledger — validate it at this boundary, the
  // journal's account_opened trusts the amounts (codex gate BLOCKER).
  if (!config.seedCash.every(isRepresentableCash)) return { status: "refused", reason: "invalid_seed_cash" };
  // A backtest is single-instrument, single-currency (the series currency). Seed
  // cash in any other currency would be held but never valued — the equity mark
  // only sees the series currency, so a mismatched seed silently vanishes from
  // the return (codex gate). Refuse rather than under-report.
  if (config.seedCash.some((money) => money.currency !== series.currency)) return { status: "refused", reason: "seed_currency_mismatch" };
  // KRX transaction tax is a KRW-market levy — a taxClass on a non-KRW series is
  // a data error, refused rather than charged in the wrong currency (codex gate).
  if (series.taxClass !== undefined && series.currency !== "KRW") return { status: "refused", reason: "tax_class_currency_mismatch" };
  for (let index = 0; index < series.bars.length; index += 1) {
    const bar = series.bars[index]!;
    if (!bar.complete) return { status: "refused", reason: "incomplete_bar" };
    // A non-finite or non-positive close cannot be a traded price: it would fold
    // into a NaN/negative equity mark (MDD outside [0,1], covered-NaN returns) —
    // refuse it at the boundary so the report never values a bad price (codex gate).
    if (!Number.isFinite(bar.close) || bar.close <= 0) return { status: "refused", reason: "invalid_bar_price" };
    // Require a timezone-qualified, real-calendar instant: a bare local time (no
    // Z/offset) parses against the runner's local zone, and JS silently
    // normalizes an impossible date (2024-02-30 → 03-01) — either would yield
    // environment- or fabrication-dependent fills/tax (codex gate).
    if (!Number.isFinite(Date.parse(bar.periodStart)) || !hasTimezone(bar.periodStart) || !isCalendarDate(bar.periodStart)) {
      return { status: "refused", reason: "invalid_bar_time" };
    }
    if (index > 0 && Date.parse(bar.periodStart) <= Date.parse(series.bars[index - 1]!.periodStart)) {
      return { status: "refused", reason: "non_monotonic_series" };
    }
    // A taxed sale in a year with no verified rate must fail closed, not
    // fabricate one (codex gate HIGH: pre-2020 rates aren't year-keyable).
    if (series.taxClass !== undefined && !isSupportedTaxDate(bar.periodStart)) {
      return { status: "refused", reason: "unsupported_tax_year" };
    }
  }

  const workspace = `backtest:${config.runId}`;
  const clock = { value: series.bars[0]!.periodStart };
  let updateCounter = 0;
  let currentObservation: PaperMarketObservation | undefined;

  const service = new PaperTradingService({
    now: () => clock.value,
    identity: { currentAuthorizationEpoch: () => "backtest" },
    observations: {
      currentObservation: (instrument) => (String(instrument) === series.instrument ? currentObservation : undefined),
    },
    policy: {
      policyVersion: SIMULATION_V1.policyVersion,
      seedCash: config.seedCash,
      intentTtlMs: 60_000,
      maxSlippageBps: SIMULATION_V1.maxSlippageBps,
    },
    updateId: () => `bt:${config.runId}:update:${(updateCounter += 1)}`,
    // journalStore omitted → in-memory (an ephemeral, deterministic run).
  });
  const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });

  const viewer: WorkspaceViewerContext = {
    kind: "workspace",
    requestId: `bt:${config.runId}`,
    workspaceReference: brandReference<string, "WorkspaceReference">(workspace),
    accountReference: brandReference<string, "AccountReference">(`bt:${config.runId}:account`),
    sessionReference: brandReference<string, "SessionReference">(`bt:${config.runId}:session`),
    sessionGeneration: brandReference<string, "SessionGeneration">("bt:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("backtest"),
    membershipRevision: brandReference<string, "MembershipRevision">("bt:1"),
  };

  // Provision the default Internal Paper Account up front so the strategy sees
  // seeded cash on the very first bar (service.open provisions genesis).
  const shell = await service.open({ requestRevision: `bt:${config.runId}` }, viewer).initial;
  if (shell.status !== "ready") return { status: "refused", reason: "no_seed_cash" };
  const account = shell.account;

  let fillCount = 0;
  let expiryCount = 0;
  const refusals: BacktestRefusal[] = [];
  // S4: per-bar equity (minor units) for the drawdown curve, and per-fill
  // participation (filled qty / bar volume) for the confidence proxy.
  const equity: number[] = [];
  const participations: number[] = [];

  for (let cursor = 0; cursor < series.bars.length; cursor += 1) {
    const bar = series.bars[cursor]!;
    clock.value = bar.periodStart;
    currentObservation = observationOf(series, bar);
    const pushRefusal = (action: "submit" | "cancel", status: string): void => {
      refusals.push({ barIndex: cursor, action, status });
    };

    // 1) Settle: this bar's observation fills/expires orders accepted at
    //    earlier bars only (engine strict `>` — same-bar acceptance can't fill).
    for (const event of await simulator.ingest(workspace, account, currentObservation)) {
      if (event.kind === "fill") {
        fillCount += 1;
        // Participation vs this bar's volume (volume > 0 whenever a fill lands —
        // the simulator refuses volume ≤ 0). Confidence proxy for candle mode.
        if (bar.volume > 0) participations.push(event.quantity / bar.volume);
      } else {
        expiryCount += 1;
      }
    }

    // Mark equity at this bar's close AFTER settling — order submission only
    // reserves (owned cash + position value is unchanged until a fill), so this
    // is the portfolio's value at the close regardless of what the strategy
    // then does. Single instrument/currency: value the series currency only.
    const settled = service.journal.state(workspace, account);
    const cashMinor = settled.cash.get(series.currency)?.balance ?? 0;
    const positionQty = settled.positions.get(series.instrument)?.quantity ?? 0;
    // Value the position with the SAME aggregate-rounding helper the fold uses,
    // so a sub-tick close rounds identically at every site (Standards gate).
    equity.push(cashMinor + grossMinorOf(positionQty, { amount: bar.close, currency: series.currency }));

    // 2) Decide at this bar's close — the view exposes bars [0, cursor] only.
    //    presentState hands out the journal's live money objects (order.fills
    //    et al.); a structuredClone isolates the strategy so it can never
    //    mutate the ledger through the view (codex gate BLOCKER: a mutated
    //    fill.quantity folded into a negative-cash / oversold report). `bar()`
    //    returns clones too, so the returned bars are read-only in effect.
    const presented = structuredClone(presentState(service.journal.state(workspace, account), account));
    const view: StrategyView = {
      cursor,
      bar(index: number): BacktestBar {
        if (!Number.isInteger(index) || index < 0 || index > cursor) {
          throw new RangeError(`bar(${index}) outside closed window [0, ${cursor}] — look-ahead refused`);
        }
        return structuredClone(series.bars[index]!);
      },
      cash: presented.cash,
      positions: presented.positions,
      orders: presented.orders,
    };
    const actions = strategy(view);
    // A strategy that forgets to return an array (a common one: an `async`
    // strategy returns a Promise) would silently produce a zero-order
    // "successful" run — refuse it as a typed fact (codex gate).
    if (!Array.isArray(actions)) return { status: "refused", reason: "invalid_strategy_result" };

    // 3) Act — accepted at this close; fillable from the next bar on.
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex]!;
      const idempotencyKey = `bt:${config.runId}:${cursor}:${actionIndex}`;
      if (action.kind === "submit") {
        const payload: PaperOrderPayload = {
          instrument: brandReference<string, "PaperInstrumentReference">(series.instrument),
          venue: series.venue,
          session: "regular",
          side: action.order.side,
          orderType: action.order.orderType,
          ...(action.order.limitPrice !== undefined ? { limitPrice: action.order.limitPrice } : {}),
          quantity: action.order.quantity,
          timeInForce: action.order.timeInForce,
        };
        const prepared = await service.prepare({ account, payload }, viewer);
        if (prepared.status !== "issued") {
          pushRefusal("submit", refusalStatus(prepared));
          continue;
        }
        const outcome = await service.change(
          { kind: "submit", account, intent: prepared.intent.reference },
          { idempotencyKey, expectedRevision: String(prepared.intent.accountRevision) },
          viewer,
        );
        if (outcome.status !== "applied") pushRefusal("submit", refusalStatus(outcome));
      } else {
        const outcome = await service.change(
          { kind: "cancel", account, order: action.order },
          // Single-threaded loop: the journal's current revision IS the CAS target.
          { idempotencyKey, expectedRevision: String(service.journal.currentRevision(workspace, account)) },
          viewer,
        );
        if (outcome.status !== "applied") pushRefusal("cancel", refusalStatus(outcome));
      }
    }
  }

  const finalState = service.journal.state(workspace, account);
  const presented = presentState(finalState, account);
  // Equity has one point per bar (series is non-empty), so [0] is the seed and
  // the last is the terminal value. A single-bar series gives a zero-width
  // window → TWR/XIRR come back `unavailable` (honest, not a fabricated 0%).
  const performance = buildPerformance({
    currency: series.currency,
    from: series.bars[0]!.periodStart,
    to: series.bars[series.bars.length - 1]!.periodStart,
    seedValue: fromMinorUnits(equity[0] ?? 0, series.currency).amount,
    finalValue: fromMinorUnits(equity[equity.length - 1] ?? 0, series.currency).amount,
    equity,
    participations,
    // S4b: the fold's per-sell realized P&L (net of tax, average-cost relief) —
    // single-currency by the seed/tax boundary refusals, so no filter needed.
    realizedSellsMinor: finalState.realizedSales.map((sale) => sale.minorUnits),
  });
  return {
    status: "complete",
    mode: "approximate",
    priceBasis,
    costModel: series.taxClass !== undefined ? KRX_TAX_POLICY_VERSION : "none",
    policyVersion: SIMULATION_V1.policyVersion,
    runId: config.runId,
    barCount: series.bars.length,
    fillCount,
    expiryCount,
    refusals,
    cash: presented.cash,
    positions: presented.positions,
    orders: presented.orders,
    performance,
  };
}
