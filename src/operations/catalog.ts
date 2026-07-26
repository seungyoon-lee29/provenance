import type { Pool } from "pg";
import { z } from "zod";

import { CLI_WORKSPACE, cliViewer, createDurablePaperTrading } from "../composition/paper-assembly";
import { runBacktest } from "../modules/paper-trading/backtest/backtest-runner";
import type { BacktestSeries } from "../modules/paper-trading/backtest/backtest-runner";
import { compileStrategy, findStrategy, STRATEGY_CATALOG } from "../modules/paper-trading/backtest/strategy-catalog";

/**
 * T10 S2 — the operation catalog.
 *
 * ONE definition, many surfaces. The CLI and the MCP server are transports:
 * they own argument parsing, streams, exit codes and protocol framing, and
 * nothing else. Everything that decides WHAT an operation does — its input
 * contract, its refusals, the shape it returns — lives here, because two
 * definitions of the same operation drift and the drift is invisible until a
 * user hits the surface that was not updated.
 *
 * Classification (ticket 41):
 *   read    — no durable state changes.
 *   compute — no durable state changes either, but not a lookup: a backtest is
 *             an in-memory deterministic run. Named separately so an agent can
 *             reason about cost, not just safety.
 *   write   — NOT IN THIS CATALOG. Order submission, settings and erasure stay
 *             off the agent surface until ticket 40's confirm token lands (T11).
 *             `paper open` is a money genesis, so it is a CLI-only command.
 *
 * Honesty rule: an operation NEVER flattens a domain outcome into a value or an
 * error. A refused backtest is `ok` at the operation layer carrying a
 * `BacktestOutcome` whose own `status` is `refused` with a typed reason, and a
 * coverage-typed metric stays `unavailable` with its reason attached. The
 * operation layer refuses only what it owns: unknown names and invalid input.
 */

export type OperationKind = "read" | "compute";

/**
 * `configuration_required` vs `unavailable` is the one distinction an agent must
 * be able to make WITHOUT reading prose: the first means "this surface was never
 * given the dependency — set it and call again", the second means "the call
 * reached storage and failed there". Both used to be `unavailable`, separable
 * only by the message string — and the moment SKILL.md tells an agent to match a
 * message, that prose becomes contract we can no longer change. Splitting before
 * publishing costs one union member; after, it costs every agent that learned
 * the old shape (T10 S4).
 *
 * `unavailable` deliberately does NOT promise "retry will help". Its catch arm
 * below is blanket, so a bug in our own code arrives wearing the same reason as
 * a dead driver, and the two cannot be told apart here without matching on
 * driver text — which SEC-05 forbids, since that text can carry the connection
 * string. SKILL.md therefore caps retries rather than inviting a wait loop; do
 * not "improve" this comment back into a liveness claim it cannot keep
 * (adversarial review round 1, 2026-07-26).
 *
 * ← 티켓 41 결정 정정: 41 은 "크리덴셜 없으면 서버는 살아있고 오퍼레이션이 outcome 을
 * 돌려준다"를 위해 `unavailable` 을 골랐다. 그 결론(서버가 죽지 않는다)은 유지된다 —
 * 바뀐 것은 그 outcome 이 기계 판독 가능한 이유를 갖느냐뿐이다.
 */
export type OperationRefusalReason =
  | "unknown_operation"
  | "invalid_input"
  | "unknown_strategy"
  | "invalid_params"
  | "configuration_required"
  | "unavailable";

export type OperationResult =
  | Readonly<{ status: "ok"; value: unknown }>
  | Readonly<{ status: "refused"; reason: OperationRefusalReason; message: string }>;

export type OperationDefinition = Readonly<{
  name: string;
  kind: OperationKind;
  summary: string;
  inputSchema: z.ZodType;
  run: (input: unknown) => Promise<OperationResult>;
}>;

export type OperationDependencies = Readonly<{
  /** Lazily resolved so a surface that never calls a durable operation never
   * opens a connection — the MCP server must start with no database. */
  pool?: () => Pool;
}>;

function refused(reason: OperationRefusalReason, message: string): OperationResult {
  return { status: "refused", reason, message };
}

/** First zod issue rendered as `path: message` — enough for a caller to fix the
 * input without dumping the whole issue tree into an agent's context. */
function issueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "invalid input";
  const path = issue.path.join(".");
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

/**
 * JSON Schema for a surface that publishes parameter contracts (CLI
 * `strategy describe`, MCP `tools/list`). `io: "input"` so a field with a
 * default is advertised as optional — the caller's view, not the parsed view.
 *
 * Caveat worth knowing: cross-field refinements (`fast < slow`) cannot be
 * expressed in JSON Schema and silently do not appear here. They are still
 * enforced — the call refuses with `invalid_params` and the reason — so the
 * published schema is a lower bound on validity, never an upper one.
 */
export function jsonSchemaOf(schema: z.ZodType): Readonly<Record<string, unknown>> {
  return z.toJSONSchema(schema, { io: "input" }) as Readonly<Record<string, unknown>>;
}

const barSchema = z.object({
  periodStart: z.string().min(1).describe("ISO instant identifying the bar; strictly increasing across the series."),
  close: z.number().positive(),
  // A whole, non-negative share count (0 = no-trade bar). Negative or
  // fractional volume otherwise reaches the simulator and is silently skipped.
  volume: z.number().int().nonnegative(),
  complete: z.boolean().describe("Incomplete bars are refused: filling on one is look-ahead."),
});

export const seriesSchema = z.object({
  instrument: z.string().min(1).describe('Paper instrument key, e.g. "instr:005930".'),
  venue: z.string().min(1),
  currency: z.string().min(1),
  // Disclosed so the runner can refuse total_return (adjusted-as-raw execution).
  priceBasis: z.enum(["raw", "split_adjusted", "total_return"]).optional(),
  // Korean transaction-tax class (T8 S3); omitted ⇒ untaxed simulation.
  taxClass: z.enum(["equity", "etf_etn"]).optional(),
  // Deliberately NOT `.min(1)`: an empty series is refused by the runner with
  // the typed reason `empty_series`, which tells a caller more than a generic
  // schema error would. The schema owns SHAPE; the engine owns domain refusals.
  bars: z.array(barSchema),
});

const strategySpecSchema = z.object({
  name: z.string().min(1).describe("Strategy name from `strategy.list`."),
  params: z.record(z.string(), z.unknown()).optional().describe("Strategy parameters; see `strategy.describe`."),
});

const backtestInputSchema = z.object({
  series: seriesSchema,
  strategy: strategySpecSchema,
  cash: z.number().positive().describe("Starting cash, in the series currency."),
});

/** What a run WOULD do, without doing it. The disclosed strategy params are the
 * PARSED ones (defaults applied), so a dry run answers "what actually runs". */
function dryRunDisclosure(
  input: z.output<typeof backtestInputSchema>,
  strategy: Readonly<{ name: string; params: Readonly<Record<string, unknown>> }>,
): Readonly<Record<string, unknown>> {
  const { bars, instrument, venue, currency, priceBasis, taxClass } = input.series;
  return {
    dryRun: true,
    strategy,
    seedCash: { amount: input.cash, currency },
    series: {
      instrument,
      venue,
      currency,
      priceBasis: priceBasis ?? "raw",
      taxClass: taxClass ?? null,
      barCount: bars.length,
      firstBar: bars[0]?.periodStart ?? null,
      lastBar: bars[bars.length - 1]?.periodStart ?? null,
    },
  };
}

export function createOperationCatalog(deps: OperationDependencies = {}): readonly OperationDefinition[] {
  const strategyList: OperationDefinition = {
    name: "strategy.list",
    kind: "read",
    summary: "List the built-in backtest strategies with a one-line summary of each.",
    inputSchema: z.object({}).strict(),
    run: async () => ({
      status: "ok",
      value: { strategies: STRATEGY_CATALOG.map(({ name, summary }) => ({ name, summary })) },
    }),
  };

  const strategyDescribe: OperationDefinition = {
    name: "strategy.describe",
    kind: "read",
    summary: "Describe one strategy: its summary and the JSON Schema of its parameters.",
    inputSchema: z.object({ name: z.string().min(1) }).strict(),
    run: async (input) => {
      const parsed = strategyDescribe.inputSchema.safeParse(input);
      if (!parsed.success) return refused("invalid_input", issueMessage(parsed.error));
      const { name } = parsed.data as { name: string };
      const definition = findStrategy(name);
      if (definition === undefined) {
        return refused("unknown_strategy", `unknown strategy "${name}" (known: ${STRATEGY_CATALOG.map((e) => e.name).join(", ")})`);
      }
      return {
        status: "ok",
        value: { name: definition.name, summary: definition.summary, params: jsonSchemaOf(definition.paramsSchema) },
      };
    },
  };

  const backtestRun: OperationDefinition = {
    name: "backtest.run",
    kind: "compute",
    summary: "Run a declarative strategy over a candle series and return a coverage-typed performance report.",
    inputSchema: backtestInputSchema.extend({
      dryRun: z.boolean().optional().describe("Resolve and disclose what would run, without running it."),
    }),
    run: async (input) => {
      const parsed = backtestRun.inputSchema.safeParse(input);
      if (!parsed.success) return refused("invalid_input", issueMessage(parsed.error));
      const { series, strategy: spec, cash, dryRun } = parsed.data as z.output<typeof backtestInputSchema> & { dryRun?: boolean };

      const compiled = compileStrategy(spec, { currency: series.currency, instrument: series.instrument });
      if (compiled.status === "refused") return refused(compiled.reason, compiled.message);
      const disclosedStrategy = { name: compiled.name, params: compiled.params };

      if (dryRun === true) return { status: "ok", value: dryRunDisclosure({ series, strategy: spec, cash }, disclosedStrategy) };

      const outcome = await runBacktest({
        runId: "operation",
        seedCash: [{ amount: cash, currency: series.currency }],
        series: series as BacktestSeries,
        strategy: compiled.strategy,
      });
      // The outcome is passed through WHOLE, refusal reason and all — see the
      // honesty rule above. `strategy` is added so a report always discloses
      // which strategy and which effective parameters produced it.
      return { status: "ok", value: { strategy: disclosedStrategy, outcome } };
    },
  };

  const paperAccount: OperationDefinition = {
    name: "paper.account",
    kind: "read",
    summary: "Read the durable local paper account: cash, positions and open orders. Never provisions one.",
    inputSchema: z.object({}).strict(),
    run: async () => {
      const resolvePool = deps.pool;
      // Reachable on the MCP surface only: `mcp/server.ts` deliberately omits the
      // pool when DATABASE_URL is unset so the server still starts. The CLI
      // always injects one (its DATABASE_URL falls back to a default), so it
      // cannot produce this arm at all.
      if (resolvePool === undefined) return refused("configuration_required", "no database is configured for this surface");
      try {
        // seedCash [] — unused on this path: `readAccount` never provisions, so
        // the seed a genesis WOULD have used is not consulted here.
        const service = createDurablePaperTrading({ pool: resolvePool(), seedCash: [] });
        const read = await service.readAccount(cliViewer());
        if (read.status === "denied") {
          // Unreachable here because `cliViewer()` always carries CLI_WORKSPACE
          // and the epoch the same assembly issues, so a denial means the wiring
          // drifted — not a fact about the account, and never a claim that none
          // exists. (The assembly's epoch stopped being a bare constant when the
          // port was narrowed to this one workspace — arch-1 round 2.)
          return refused("unavailable", "paper account is not readable on this surface");
        }
        if (read.status === "absent") return { status: "ok", value: { workspace: CLI_WORKSPACE, exists: false } };
        const { account, cash, positions, orders } = read;
        return { status: "ok", value: { workspace: CLI_WORKSPACE, exists: true, account: String(account), cash, positions, orders } };
      } catch {
        // SEC-05: never copy a raw driver error out — a Postgres connection
        // failure message can carry DATABASE_URL, password and all.
        return refused("unavailable", "database unavailable");
      }
    },
  };

  return [strategyList, strategyDescribe, backtestRun, paperAccount];
}

export type OperationCatalog = Readonly<{
  list: () => readonly OperationDefinition[];
  find: (name: string) => OperationDefinition | undefined;
  call: (name: string, input: unknown) => Promise<OperationResult>;
}>;

export function operationCatalog(deps: OperationDependencies = {}): OperationCatalog {
  const operations = createOperationCatalog(deps);
  const find = (name: string): OperationDefinition | undefined => operations.find((operation) => operation.name === name);
  return {
    list: () => operations,
    find,
    call: async (name, input) => {
      const operation = find(name);
      if (operation === undefined) {
        return refused("unknown_operation", `unknown operation "${name}" (known: ${operations.map((o) => o.name).join(", ")})`);
      }
      return operation.run(input);
    },
  };
}
