import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Pool } from "pg";

import { CLI_WORKSPACE, cliViewer, createDurablePaperTrading } from "../composition/paper-assembly";
import { runBacktest } from "../modules/paper-trading/backtest/backtest-runner";
import type { BacktestStrategy } from "../modules/paper-trading/backtest/backtest-runner";
import { operationCatalog, seriesSchema } from "../operations/catalog";
import type { OperationDependencies, OperationRefusalReason, OperationResult } from "../operations/catalog";
import { getDatabasePool } from "../platform/runtime/dependencies";

/**
 * T8 S2 / T10 S2 — CLI command handlers.
 *
 * The CLI is a TRANSPORT over the operation catalog (`operations/catalog.ts`):
 * it reads files, parses flags and maps outcomes onto an envelope and an exit
 * code. It does not decide what an operation means — that would be a second
 * definition, drifting from the MCP surface's.
 *
 * Envelope discipline (pivot T10 메모, [개선해서 차용]): success and failure
 * share ONE envelope shape, --json is available on every command without
 * exception, and handlers never write to stdout/stderr themselves — the entry
 * point owns the streams, so a --json pipe can never be polluted (the reference
 * repo's order banner breaking `--json | jq` is the anti-example).
 *
 * Exit codes (차용 ④): 0 success · 1 general/usage/refused · 2 API/infra ·
 * 3 auth (unused until KIS credentials land, T11).
 */

export type CliErrorCode = "usage" | "refused" | "api" | "crash";

export type CliEnvelope =
  | Readonly<{ ok: true; command: string; result: unknown }>
  | Readonly<{ ok: false; command: string; error: Readonly<{ code: CliErrorCode; message: string }> }>;

export type CliOutcome = Readonly<{ envelope: CliEnvelope; exitCode: 0 | 1 | 2 | 3 }>;

function ok(command: string, result: unknown): CliOutcome {
  return { envelope: { ok: true, command, result }, exitCode: 0 };
}

function fail(command: string, code: CliErrorCode, message: string): CliOutcome {
  return { envelope: { ok: false, command, error: { code, message } }, exitCode: code === "api" ? 2 : 1 };
}

/**
 * Map an operation refusal onto the CLI's error vocabulary.
 *
 * Exhaustive by type, not by ternary: a `Record` over the union means adding an
 * operation reason without deciding its exit code is a compile error. The old
 * `reason === "unavailable" ? api : usage` form silently classified every future
 * reason as caller input (exit 1), which is the wrong default — a new reason is
 * far more likely to be environmental than to be the caller's typo.
 */
export const OPERATION_REASON_TO_CLI: Record<OperationRefusalReason, CliErrorCode> = {
  unknown_operation: "usage",
  invalid_input: "usage",
  unknown_strategy: "usage",
  invalid_params: "usage",
  // Environment, not caller input — both are exit 2 (API/infra). The CLI cannot
  // actually produce `configuration_required` (it always injects a pool), but
  // the mapping has to be right for the day another transport shares this code.
  configuration_required: "api",
  unavailable: "api",
};

function fromOperation(command: string, result: OperationResult): CliOutcome {
  if (result.status === "ok") return ok(command, result.value);
  return fail(command, OPERATION_REASON_TO_CLI[result.reason], result.message);
}

/**
 * A refused backtest is a TRANSPORT-level failure for the CLI (exit 1, code
 * `refused`) even though it is a successful operation carrying a typed domain
 * outcome. Both readings are correct for their audience: a shell pipeline needs
 * a non-zero status to branch on, while an agent needs the refusal REASON, so
 * the MCP surface keeps the whole outcome and only the CLI collapses it.
 */
function withBacktestExitCode(command: string, result: OperationResult): CliOutcome {
  if (result.status !== "ok") return fromOperation(command, result);
  const outcome = (result.value as { outcome?: { status?: string; reason?: string } }).outcome;
  if (outcome?.status === "refused") return fail(command, "refused", `backtest refused: ${outcome.reason}`);
  return ok(command, result.value);
}

function catalogFor(deps?: Readonly<{ pool?: Pool }>): ReturnType<typeof operationCatalog> {
  const dependencies: OperationDependencies = { pool: () => deps?.pool ?? getDatabasePool() };
  return operationCatalog(dependencies);
}

/**
 * Loading a strategy as an arbitrary TypeScript module executes that file. For
 * a human at a local shell that is a feature; for anything agent-driven it is
 * remote code execution, and an agent CAN drive this CLI (that is the point of
 * SKILL.md). Excluding module paths from the MCP catalog is therefore not
 * containment on its own — the gate has to be here, at the CLI boundary.
 *
 * Fail-closed on any value but the exact string "true", matching the repo's
 * opt-in egress flags (`PUBLIC_MARKET_ENABLED`).
 */
export const STRATEGY_MODULE_FLAG = "BACKTEST_STRATEGY_MODULE_ENABLED";

/** Only this exact string enables it — `"1"`, `"TRUE"` and `"true "` do not. */
function moduleStrategyAllowed(env: CliEnv): boolean {
  return env[STRATEGY_MODULE_FLAG] === "true";
}

/** Only `BACKTEST_STRATEGY_MODULE_ENABLED` is ever read; a full `ProcessEnv` is
 * neither needed nor demanded of callers. */
export type CliEnv = Readonly<Record<string, string | undefined>>;

export type BacktestArgs = Readonly<{
  series: string;
  /** Built-in strategy name (declarative path). */
  strategy?: string;
  /** Raw JSON parameters for the named strategy. */
  params?: string;
  /** Path to a TypeScript module exporting a BacktestStrategy — gated. */
  strategyModule?: string;
  cash: number;
  dryRun?: boolean;
}>;

export async function runBacktestCommand(args: BacktestArgs, env: CliEnv = process.env): Promise<CliOutcome> {
  const command = "backtest run";
  if (!Number.isFinite(args.cash) || args.cash <= 0) {
    return fail(command, "usage", "starting cash must be a positive amount in the series currency");
  }
  if ((args.strategy === undefined) === (args.strategyModule === undefined)) {
    return fail(command, "usage", "give exactly one of --strategy <name> or --strategy-module <file>");
  }
  // The gate precedes ALL IO: a disabled module strategy must not even cause a
  // filesystem read of the caller's series path.
  if (args.strategyModule !== undefined && !moduleStrategyAllowed(env)) {
    return fail(
      command,
      "refused",
      `--strategy-module executes an arbitrary file and is disabled; set ${STRATEGY_MODULE_FLAG}=true to allow it, or use --strategy <name>`,
    );
  }

  let raw: string;
  try {
    raw = await readFile(resolve(args.series), "utf8");
  } catch (error) {
    // The filesystem error names the path the CALLER supplied, so echoing it
    // discloses nothing they did not already hand us.
    return fail(command, "usage", `cannot read series file: ${error instanceof Error ? error.message : String(error)}`);
  }

  let series: unknown;
  try {
    series = JSON.parse(raw);
  } catch {
    // SEC-05, same rule as the driver-error arm in `operations/catalog.ts`: a
    // `JSON.parse` failure quotes the OFFENDING SOURCE TEXT, so echoing it turns
    // "point this flag at a file" into "print that file". Aiming --series at
    // `.env.local` returned `Unexpected token 'D', "DATABASE_U"...` before this
    // split — bounded by V8's snippet length, but content is content, and an
    // agent drives this flag. Fixed string; the caller knows which file it named.
    return fail(command, "usage", "series file is not valid JSON");
  }

  if (args.strategyModule !== undefined) {
    return runModuleStrategy(command, args, series);
  }

  let params: unknown;
  if (args.params !== undefined) {
    try {
      params = JSON.parse(args.params);
    } catch (error) {
      return fail(command, "usage", `--params is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return withBacktestExitCode(
    command,
    await catalogFor().call("backtest.run", {
      series,
      strategy: { name: args.strategy, ...(params === undefined ? {} : { params }) },
      cash: args.cash,
      ...(args.dryRun === true ? { dryRun: true } : {}),
    }),
  );
}

/** The gated escape hatch (caller already checked the flag): same runner, same
 * series contract, but the strategy is whatever the loaded module exports.
 * Never reachable from the catalog, and therefore never from MCP. */
async function runModuleStrategy(command: string, args: BacktestArgs, rawSeries: unknown): Promise<CliOutcome> {
  const parsed = seriesSchema.safeParse(rawSeries);
  if (!parsed.success) {
    return fail(command, "usage", `series file failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }

  let strategy: BacktestStrategy;
  try {
    const loaded: unknown = await import(pathToFileURL(resolve(args.strategyModule as string)).href);
    const candidate = (loaded as { default?: unknown; strategy?: unknown }).default
      ?? (loaded as { strategy?: unknown }).strategy;
    if (typeof candidate !== "function") {
      return fail(command, "usage", "strategy module must export a BacktestStrategy function (default or `strategy`)");
    }
    strategy = candidate as BacktestStrategy;
  } catch (error) {
    return fail(command, "usage", `cannot load strategy module: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (args.dryRun === true) {
    return ok(command, { dryRun: true, strategy: { module: args.strategyModule }, series: { barCount: parsed.data.bars.length } });
  }
  const outcome = await runBacktest({
    runId: "cli",
    seedCash: [{ amount: args.cash, currency: parsed.data.currency }],
    series: parsed.data,
    strategy,
  });
  return withBacktestExitCode(command, { status: "ok", value: { strategy: { module: args.strategyModule }, outcome } });
}

/**
 * Generic catalog access: every operation is reachable without a bespoke
 * command, so adding an operation costs nothing on this surface (the MCP tools
 * are already generic over the catalog — this keeps the CLI symmetric).
 *
 * EXIT-CODE CONTRACT, deliberately different from `backtest run`: a successful
 * operation is exit 0 even when the domain outcome inside it is a refusal,
 * because the CALL succeeded and the reason is in the envelope. Only
 * operation-layer refusals (unknown name, invalid input, unavailable) are
 * non-zero. Scripts that want a refused backtest to fail the shell should use
 * the dedicated `backtest run`, which collapses it to exit 1.
 */
export async function callCommand(
  operation: string | undefined,
  rawInput: string | undefined,
  deps?: Readonly<{ pool?: Pool }>,
): Promise<CliOutcome> {
  const command = "call";
  const catalog = catalogFor(deps);
  if (operation === undefined) {
    return ok(command, {
      operations: catalog.list().map(({ name, kind, summary }) => ({ operation: name, kind, summary })),
    });
  }
  let input: unknown = {};
  if (rawInput !== undefined) {
    try {
      input = JSON.parse(rawInput);
    } catch (error) {
      return fail(command, "usage", `--input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return fromOperation(command, await catalog.call(operation, input));
}

export async function strategyListCommand(): Promise<CliOutcome> {
  return fromOperation("strategy list", await catalogFor().call("strategy.list", {}));
}

export async function strategyDescribeCommand(name: string): Promise<CliOutcome> {
  return fromOperation("strategy describe", await catalogFor().call("strategy.describe", { name }));
}

export async function paperAccountCommand(deps?: Readonly<{ pool?: Pool }>): Promise<CliOutcome> {
  return fromOperation("paper account", await catalogFor(deps).call("paper.account", {}));
}

/**
 * Provision (genesis-once) the durable CLI paper account and report its state.
 *
 * CLI-ONLY BY DESIGN: this is a WRITE — it opens a money ledger. Ticket 41
 * keeps writes off the agent surface until ticket 40's confirm token lands, so
 * it is deliberately absent from the operation catalog.
 */
export async function paperOpenCommand(
  args: Readonly<{ seed: number; currency: string }>,
  deps?: Readonly<{ pool?: Pool }>,
): Promise<CliOutcome> {
  const command = "paper open";
  if (!Number.isFinite(args.seed) || args.seed <= 0) {
    return fail(command, "usage", "starting cash must be a positive amount");
  }
  if (args.currency !== "KRW" && args.currency !== "USD") {
    return fail(command, "usage", "--currency must be KRW or USD");
  }
  try {
    const pool = deps?.pool ?? getDatabasePool();
    const service = createDurablePaperTrading({ pool, seedCash: [{ amount: args.seed, currency: args.currency }] });
    // Read BEFORE opening: the read never provisions, so what it sees is this
    // process's pre-genesis view. Same service instance, so both share one
    // hydration. NOT atomic with the open below — two CLIs racing the same
    // database can both report `created: true` while only one genesis lands
    // (the loser's ledger is intact, its OUTPUT is wrong). Single-owner is this
    // surface's assumption, not an invariant the store enforces; a second local
    // owner needs a genesis outcome from `open` itself, not a read-then-write.
    const before = await service.readAccount(cliViewer());
    // `api` (exit 2), not `crash`: this is the wiring-drift condition, and the
    // same condition on the `paper.account` surface maps to `unavailable` → api
    // → exit 2 (see `fromOperation`). One fact must not leave two surfaces with
    // two exit codes — an agent branching on exit 2 for infra would misread
    // `paper open` alone as a caller-input error.
    if (before.status === "denied") return fail(command, "api", "paper account is not readable on this surface");
    const shell = await service.open({ requestRevision: "cli" }, cliViewer()).initial;
    if (shell.status !== "ready") return fail(command, "crash", `unexpected shell status: ${shell.status}`);
    // Genesis is once-only: a second open with a different seed keeps the
    // ORIGINAL ledger untouched — reported honestly via `created`.
    return ok(command, { workspace: CLI_WORKSPACE, account: String(shell.account), created: before.status === "absent", cash: shell.cash, positions: shell.positions });
  } catch {
    // SEC-05: never copy a raw driver error into output — a Postgres connection
    // failure message can carry the DATABASE_URL, password and all. Fixed string.
    return fail(command, "api", "database unavailable");
  }
}
