import { z } from "zod";

import { marketReservationUnitPrice } from "../internal/service";
import { SIMULATION_V1 } from "../internal/simulator";
import type { BacktestStrategy, StrategyAction, StrategyView } from "./backtest-runner";

/**
 * T10 S1 — the declarative strategy layer.
 *
 * WHY THIS EXISTS: the CLI can load a strategy as an arbitrary TypeScript
 * module (a dynamic `import` of a caller-supplied path). That is fine for a
 * human at a local shell, but the MCP surface (ticket 41) exposes "run a
 * backtest" as an agent-callable `compute` operation — and an operation that
 * takes a module path is remote code execution wearing a backtest costume.
 * So a strategy must also be expressible as DATA: a name plus validated
 * parameters, resolved against this fixed registry. Nothing here can name a
 * file, reach the filesystem, or open a socket.
 *
 * Containment: a compiled strategy is only an INPUT to the runner. Every order
 * it emits still passes `prepare` → `validateSystemBody` → `#covered`, so the
 * worst a pathological strategy achieves is a recorded refusal, never a
 * corrupted ledger. Strategies are pure functions of the view — no clock, no
 * randomness — because a backtest that is not reproducible is not evidence.
 */

/**
 * Buy sizing divides by the RESERVATION price, not the bar close.
 *
 * Two independent boundaries reject an order sized at `floor(cash / close)`,
 * and both fail as a silently empty run rather than an error:
 *   - `prepare` reserves `quantity × marketReservationUnitPrice(...)` and
 *     refuses `insufficient_cash` when that exceeds available cash;
 *   - `#covered` (simulator.ts:259) re-judges affordability at the slipped fill
 *     price and skips the WHOLE allocation rather than shaving it.
 * Either way the report is green with zero fills — exactly the "plausible false
 * performance" this module's tier declaration names.
 *
 * The reservation price is imported, not re-derived: it applies the slippage
 * ceiling AND rounds up to the tick, and an approximation that skips the tick
 * rounding is wrong by up to one tick per share (measured, T10 S1).
 */
function reservationPrice(close: number, currency: string): number {
  return marketReservationUnitPrice(close, currency, SIMULATION_V1.maxSlippageBps);
}

/**
 * Every built-in submits GTC, and `timeInForce` is deliberately NOT a
 * parameter.
 *
 * On a DAILY series a DAY order can never fill: expiry pass 1 clears open DAY
 * orders as soon as `utcDay(observation) > utcDay(acceptedAt)`
 * (simulator.ts:117), and a fill requires `eventTime > acceptedAt` strictly —
 * so the first observation that could fill it is already the next calendar day
 * that expires it. (On an intraday series DAY behaves normally; this is the
 * engine's semantics, not a bug.) Exposing the knob would hand every user a
 * default-shaped way to produce an empty run, so the registry does not.
 *
 * GTC also composes with the 10% volume-participation cap: a large order fills
 * across several bars instead of being abandoned.
 */
const BUILT_IN_TIME_IN_FORCE = "GTC" as const;

/** Series facts a strategy needs but `StrategyView` does not carry. Supplied at
 * compile time by whoever owns the series (CLI, MCP), never by the strategy. */
export type StrategyContext = Readonly<{
  /** Series currency — selects the cash row to size against. */
  currency: string;
  /** Paper instrument key (e.g. "instr:005930") — selects the position row. */
  instrument: string;
}>;

export type StrategyDefinition = Readonly<{
  name: string;
  summary: string;
  /** Exposed so `strategy describe` / MCP `describe_operation` can publish the
   * parameter contract instead of re-stating it in prose. */
  paramsSchema: z.ZodType;
  compile: (rawParams: unknown, context: StrategyContext) => BuiltStrategy;
}>;

type BuiltStrategy =
  | Readonly<{ ok: true; strategy: BacktestStrategy; params: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; message: string }>;

/** Binds a definition's parameter type to its builder without a cast: the
 * generic infers `P` from the schema, so `build` sees parsed, defaulted params. */
function define<S extends z.ZodType<Readonly<Record<string, unknown>>>>(
  definition: Readonly<{
    name: string;
    summary: string;
    paramsSchema: S;
    build: (params: z.output<S>, context: StrategyContext) => BacktestStrategy;
  }>,
): StrategyDefinition {
  return {
    name: definition.name,
    summary: definition.summary,
    paramsSchema: definition.paramsSchema,
    compile: (rawParams, context) => {
      const parsed = definition.paramsSchema.safeParse(rawParams ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue?.path.join(".");
        return { ok: false, message: `${path !== undefined && path.length > 0 ? `${path}: ` : ""}${issue?.message ?? "invalid parameters"}` };
      }
      // Echo the PARSED params (defaults applied) — the report must disclose
      // what actually ran, not what the caller happened to type.
      return { ok: true, strategy: definition.build(parsed.data, context), params: parsed.data };
    },
  };
}

const cashFractionSchema = z
  .number()
  .gt(0)
  .lte(1)
  .default(1)
  .describe("Share of available cash to commit per entry (0 < f ≤ 1).");

/** Available cash in the series currency, or 0 when the account holds none. */
function availableCash(view: StrategyView, currency: string): number {
  return view.cash.find((row) => row.currency === currency)?.available ?? 0;
}

/** Unreserved quantity held of the series instrument (what a sell may cover). */
function sellableQuantity(view: StrategyView, instrument: string): number {
  const position = view.positions.find((row) => String(row.instrument) === instrument);
  if (position === undefined) return 0;
  return Math.max(0, position.quantity - position.reserved);
}

/** Whole shares affordable at the reservation price — see `reservationPrice`. */
function affordableQuantity(view: StrategyView, context: StrategyContext, close: number, fraction: number): number {
  const budget = availableCash(view, context.currency) * fraction;
  const quantity = Math.floor(budget / reservationPrice(close, context.currency));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
}

/** Orders still capable of consuming cash or shares. A strategy that ignores
 * these double-commits and gets refused at the boundary. */
function liveOrders(view: StrategyView): readonly StrategyView["orders"][number][] {
  return view.orders.filter(
    (order) =>
      (order.execution === "open" || order.execution === "partially_filled" || order.execution === "not_started")
      && order.cancellation !== "confirmed",
  );
}

function marketOrder(side: "buy" | "sell", quantity: number): StrategyAction {
  return { kind: "submit", order: { side, orderType: "market", quantity, timeInForce: BUILT_IN_TIME_IN_FORCE } };
}

/** Mean close over the `window` bars ending at `end` (inclusive). The caller
 * guarantees the window is fully behind the cursor — `view.bar` throws a
 * RangeError past it, which is the look-ahead guard, not an error path. */
function simpleMovingAverage(view: StrategyView, end: number, window: number): number {
  let total = 0;
  for (let index = end - window + 1; index <= end; index += 1) total += view.bar(index).close;
  return total / window;
}

const BUY_AND_HOLD = define({
  name: "buy_and_hold",
  summary: "Buy once at the first bar's close and hold to the end of the series. The baseline every other strategy is measured against.",
  paramsSchema: z.object({ cashFraction: cashFractionSchema }).strict(),
  build: (params, context) => (view) => {
    if (view.cursor !== 0) return [];
    const quantity = affordableQuantity(view, context, view.bar(0).close, params.cashFraction);
    return quantity > 0 ? [marketOrder("buy", quantity)] : [];
  },
});

const SMA_CROSS = define({
  name: "sma_cross",
  summary: "Go long when the fast simple moving average crosses above the slow one, and flat when it crosses back below.",
  paramsSchema: z
    .object({
      fast: z.number().int().positive().describe("Fast SMA window in bars."),
      slow: z.number().int().positive().describe("Slow SMA window in bars."),
      cashFraction: cashFractionSchema,
    })
    .strict()
    .refine((params) => params.fast < params.slow, { message: "fast must be strictly less than slow", path: ["fast"] }),
  build: (params, context) => (view) => {
    // Need a full slow window at the cursor AND at the previous bar, otherwise
    // there is no "before" to compare against and no cross can be defined.
    if (view.cursor < params.slow) return [];
    const previousFast = simpleMovingAverage(view, view.cursor - 1, params.fast);
    const previousSlow = simpleMovingAverage(view, view.cursor - 1, params.slow);
    const currentFast = simpleMovingAverage(view, view.cursor, params.fast);
    const currentSlow = simpleMovingAverage(view, view.cursor, params.slow);

    if (previousFast <= previousSlow && currentFast > currentSlow) {
      // Golden cross — enter, unless already committed (held shares or a live
      // order). Re-entering on top of an unfilled order just burns refusals.
      if (sellableQuantity(view, context.instrument) > 0 || liveOrders(view).length > 0) return [];
      const quantity = affordableQuantity(view, context, view.bar(view.cursor).close, params.cashFraction);
      return quantity > 0 ? [marketOrder("buy", quantity)] : [];
    }

    if (previousFast >= previousSlow && currentFast < currentSlow) {
      // Death cross — go flat. Cancel first: an open buy would otherwise keep
      // filling into the exit, and its cash reservation is not sellable anyway.
      const cancellations: StrategyAction[] = liveOrders(view).map((order) => ({ kind: "cancel", order: order.order }));
      const quantity = sellableQuantity(view, context.instrument);
      return quantity > 0 ? [...cancellations, marketOrder("sell", quantity)] : cancellations;
    }

    return [];
  },
});

export const STRATEGY_CATALOG: readonly StrategyDefinition[] = [BUY_AND_HOLD, SMA_CROSS];

export type StrategyCompilation =
  | Readonly<{ status: "compiled"; strategy: BacktestStrategy; name: string; params: Readonly<Record<string, unknown>> }>
  | Readonly<{ status: "refused"; reason: "unknown_strategy" | "invalid_params"; message: string }>;

export function findStrategy(name: string): StrategyDefinition | undefined {
  return STRATEGY_CATALOG.find((definition) => definition.name === name);
}

/**
 * Resolve a declarative spec against the registry. Refusal is a typed outcome,
 * never a throw — the caller (CLI envelope, MCP tool result) reports the reason
 * to whoever asked, and an agent can act on `unknown_strategy` differently from
 * `invalid_params`.
 */
export function compileStrategy(
  spec: Readonly<{ name: string; params?: unknown }>,
  context: StrategyContext,
): StrategyCompilation {
  const definition = findStrategy(spec.name);
  if (definition === undefined) {
    const known = STRATEGY_CATALOG.map((entry) => entry.name).join(", ");
    return { status: "refused", reason: "unknown_strategy", message: `unknown strategy "${spec.name}" (known: ${known})` };
  }
  const built = definition.compile(spec.params, context);
  if (!built.ok) return { status: "refused", reason: "invalid_params", message: built.message };
  return { status: "compiled", strategy: built.strategy, name: definition.name, params: built.params };
}
