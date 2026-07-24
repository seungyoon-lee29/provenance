import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Pool } from "pg";
import { z } from "zod";

import { CLI_WORKSPACE, createDurablePaperTrading } from "../composition/paper-assembly";
import { runBacktest } from "../modules/paper-trading/backtest/backtest-runner";
import type { BacktestSeries, BacktestStrategy } from "../modules/paper-trading/backtest/backtest-runner";
import { defaultPaperAccount, presentState } from "../modules/paper-trading/internal/service";
import { getDatabasePool } from "../platform/runtime/dependencies";
import { brandReference } from "../shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";

/**
 * T8 S2 — CLI command handlers. Envelope discipline (pivot T10 메모,
 * [개선해서 차용]): success and failure share ONE envelope shape, --json is
 * available on every command without exception, and handlers never write to
 * stdout/stderr themselves — the entry point owns the streams, so a --json
 * pipe can never be polluted (the reference repo's order banner breaking
 * `--json | jq` is the anti-example).
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

const seriesSchema = z.object({
  instrument: z.string().min(1),
  venue: z.string().min(1),
  currency: z.string().min(1),
  // Disclosed so the runner can refuse total_return (adjusted-as-raw execution).
  priceBasis: z.enum(["raw", "split_adjusted", "total_return"]).optional(),
  bars: z.array(
    z.object({
      periodStart: z.string().min(1),
      close: z.number().positive(),
      // Bar volume: a whole, non-negative share count (0 = no-trade bar).
      // Negative/fractional volume otherwise reaches the simulator and is
      // silently skipped (codex gate) — reject it at the boundary instead.
      volume: z.number().int().nonnegative(),
      complete: z.boolean(),
    }),
  ),
});

function cliViewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "cli",
    workspaceReference: brandReference<string, "WorkspaceReference">(CLI_WORKSPACE),
    accountReference: brandReference<string, "AccountReference">("cli:account"),
    sessionReference: brandReference<string, "SessionReference">("cli:session"),
    sessionGeneration: brandReference<string, "SessionGeneration">("cli:1"),
    // Must equal the assembly's constant epoch or #authorized denies.
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("cli"),
    membershipRevision: brandReference<string, "MembershipRevision">("cli:1"),
  };
}

export async function runBacktestCommand(
  args: Readonly<{ series: string; strategy: string; seed: number }>,
): Promise<CliOutcome> {
  const command = "backtest run";
  if (!Number.isFinite(args.seed) || args.seed <= 0) {
    return fail(command, "usage", "starting cash must be a positive amount in the series currency");
  }

  let series: BacktestSeries;
  try {
    const parsed = seriesSchema.safeParse(JSON.parse(await readFile(resolve(args.series), "utf8")));
    if (!parsed.success) return fail(command, "usage", `series file failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    series = parsed.data;
  } catch (error) {
    return fail(command, "usage", `cannot read series file: ${error instanceof Error ? error.message : String(error)}`);
  }

  let strategy: BacktestStrategy;
  try {
    const loaded: unknown = await import(pathToFileURL(resolve(args.strategy)).href);
    const candidate = (loaded as { default?: unknown; strategy?: unknown }).default
      ?? (loaded as { strategy?: unknown }).strategy;
    if (typeof candidate !== "function") {
      return fail(command, "usage", "strategy module must export a BacktestStrategy function (default or `strategy`)");
    }
    strategy = candidate as BacktestStrategy;
  } catch (error) {
    return fail(command, "usage", `cannot load strategy module: ${error instanceof Error ? error.message : String(error)}`);
  }

  const outcome = await runBacktest({
    runId: "cli",
    seedCash: [{ amount: args.seed, currency: series.currency }],
    series,
    strategy,
  });
  if (outcome.status === "refused") return fail(command, "refused", `backtest refused: ${outcome.reason}`);
  return ok(command, outcome);
}

/** Provision (genesis-once) the durable CLI paper account and report its state. */
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
    await service.journal.init();
    const account = defaultPaperAccount(CLI_WORKSPACE);
    const existed = service.journal.ownerOf(account) !== undefined;
    const shell = await service.open({ requestRevision: "cli" }, cliViewer()).initial;
    if (shell.status !== "ready") return fail(command, "crash", `unexpected shell status: ${shell.status}`);
    // Genesis is once-only: a second open with a different seed keeps the
    // ORIGINAL ledger untouched — reported honestly via `created`.
    return ok(command, { workspace: CLI_WORKSPACE, account: String(account), created: !existed, cash: shell.cash, positions: shell.positions });
  } catch {
    // SEC-05: never copy a raw driver error into output — a Postgres connection
    // failure message can carry the DATABASE_URL, password and all. Fixed string.
    return fail(command, "api", "database unavailable");
  }
}

/** Read-only durable account view. NEVER provisions — a read must not create
 * a money genesis (service.open would, so this goes through the journal). */
export async function paperAccountCommand(deps?: Readonly<{ pool?: Pool }>): Promise<CliOutcome> {
  const command = "paper account";
  try {
    const pool = deps?.pool ?? getDatabasePool();
    const service = createDurablePaperTrading({ pool, seedCash: [] });
    await service.journal.init();
    const account = defaultPaperAccount(CLI_WORKSPACE);
    if (service.journal.ownerOf(account) === undefined) {
      return ok(command, { workspace: CLI_WORKSPACE, exists: false });
    }
    const presented = presentState(service.journal.state(CLI_WORKSPACE, account), account);
    return ok(command, { workspace: CLI_WORKSPACE, exists: true, account: String(account), ...presented });
  } catch {
    // SEC-05: never copy a raw driver error into output — a Postgres connection
    // failure message can carry the DATABASE_URL, password and all. Fixed string.
    return fail(command, "api", "database unavailable");
  }
}
