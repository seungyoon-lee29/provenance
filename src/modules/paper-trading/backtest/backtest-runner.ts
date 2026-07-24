import { brandReference } from "../../../shared/contracts/brands";
import type { PaperOrderReference } from "../../../shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";

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
 * Look-ahead is blocked in two layers:
 * - Fills: the engine already refuses `eventTime/dataClock <= acceptedAt`
 *   (simulator §9), so an order accepted at bar N's close can only fill from
 *   bar N+1 on — close-accept/next-bar-fill falls out of the invariant.
 * - Strategy: `StrategyView.bar()` throws past the cursor; probing the future
 *   crashes the run instead of silently improving it.
 *
 * Determinism: the clock is the bar cursor (no wall clock), ids derive from
 * (runId, barIndex, actionIndex), and the journal is the in-memory store —
 * a backtest run is an ephemeral computation (durable paper sessions are the
 * CLI's concern, S2).
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
  policyVersion: string;
  runId: string;
  barCount: number;
  fillCount: number;
  expiryCount: number;
  refusals: readonly BacktestRefusal[];
  cash: readonly PaperCashRow[];
  positions: readonly PaperPositionRow[];
  orders: readonly PaperOrderView[];
}>;

export type BacktestOutcome =
  | BacktestReport
  | Readonly<{
      status: "refused";
      reason: "empty_series" | "incomplete_bar" | "invalid_bar_time" | "non_monotonic_series" | "no_seed_cash";
    }>;

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
  };
}

export async function runBacktest(config: BacktestConfig): Promise<BacktestOutcome> {
  const { series, strategy } = config;
  if (series.bars.length === 0) return { status: "refused", reason: "empty_series" };
  if (config.seedCash.length === 0) return { status: "refused", reason: "no_seed_cash" };
  for (let index = 0; index < series.bars.length; index += 1) {
    const bar = series.bars[index]!;
    if (!bar.complete) return { status: "refused", reason: "incomplete_bar" };
    if (!Number.isFinite(Date.parse(bar.periodStart))) return { status: "refused", reason: "invalid_bar_time" };
    if (index > 0 && Date.parse(bar.periodStart) <= Date.parse(series.bars[index - 1]!.periodStart)) {
      return { status: "refused", reason: "non_monotonic_series" };
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

  for (let cursor = 0; cursor < series.bars.length; cursor += 1) {
    const bar = series.bars[cursor]!;
    clock.value = bar.periodStart;
    currentObservation = observationOf(series, bar);

    // 1) Settle: this bar's observation fills/expires orders accepted at
    //    earlier bars only (engine strict `>` — same-bar acceptance can't fill).
    for (const event of await simulator.ingest(workspace, account, currentObservation)) {
      if (event.kind === "fill") fillCount += 1;
      else expiryCount += 1;
    }

    // 2) Decide at this bar's close — the view exposes bars [0, cursor] only.
    const presented = presentState(service.journal.state(workspace, account), account);
    const view: StrategyView = {
      cursor,
      bar(index: number): BacktestBar {
        if (!Number.isInteger(index) || index < 0 || index > cursor) {
          throw new RangeError(`bar(${index}) outside closed window [0, ${cursor}] — look-ahead refused`);
        }
        return series.bars[index]!;
      },
      cash: presented.cash,
      positions: presented.positions,
      orders: presented.orders,
    };
    const actions = strategy(view);

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
          refusals.push({
            barIndex: cursor,
            action: "submit",
            status: prepared.status === "refused" ? prepared.reason : prepared.status,
          });
          continue;
        }
        const outcome = await service.change(
          { kind: "submit", account, intent: prepared.intent.reference },
          { idempotencyKey, expectedRevision: String(prepared.intent.accountRevision) },
          viewer,
        );
        if (outcome.status !== "applied") {
          refusals.push({
            barIndex: cursor,
            action: "submit",
            status: outcome.status === "refused" ? outcome.reason : outcome.status,
          });
        }
      } else {
        const outcome = await service.change(
          { kind: "cancel", account, order: action.order },
          // Single-threaded loop: the journal's current revision IS the CAS target.
          { idempotencyKey, expectedRevision: String(service.journal.currentRevision(workspace, account)) },
          viewer,
        );
        if (outcome.status !== "applied") {
          refusals.push({
            barIndex: cursor,
            action: "cancel",
            status: outcome.status === "refused" ? outcome.reason : outcome.status,
          });
        }
      }
    }
  }

  const presented = presentState(service.journal.state(workspace, account), account);
  return {
    status: "complete",
    mode: "approximate",
    policyVersion: SIMULATION_V1.policyVersion,
    runId: config.runId,
    barCount: series.bars.length,
    fillCount,
    expiryCount,
    refusals,
    cash: presented.cash,
    positions: presented.positions,
    orders: presented.orders,
  };
}
