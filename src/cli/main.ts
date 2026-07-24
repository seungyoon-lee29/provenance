import { parseArgs } from "node:util";

import { paperAccountCommand, paperOpenCommand, runBacktestCommand } from "./commands";
import type { CliOutcome } from "./commands";

/**
 * T8 S2 — CLI entry. Run via `node --import tsx src/cli/main.ts <command> ...`,
 * or `npm run cli -- <command> ...`; the packaged bin is the Stage 3 release
 * re-definition. This file owns the streams: stdout carries EXACTLY the command
 * output (single-line envelope with --json, pretty result without), everything
 * else — usage, human-facing errors — goes to stderr. Exit codes: 0 success ·
 * 1 general/usage/refused · 2 API/infra · 3 auth (RESERVED for T11 credentials,
 * currently unreachable).
 *
 * --json stdout purity caveat: THIS file emits only the envelope, but two
 * things outside it can still write to stdout — `npm run` prints a script
 * banner (use `npm run --silent`, or invoke node/tsx directly), and an
 * imported strategy module's top-level `console.log` prints before the run.
 * For a clean `--json | jq` pipe, invoke node/tsx directly and keep strategy
 * modules side-effect-free (enforced by convention until the packaged bin).
 */

const USAGE = `provenance — 한국 시장 백테스트 + 모의투자 엔진 (T8 S2 골격)

  backtest run --series <file.json> --strategy <file.ts> --cash <amount> [--json]
  paper open --cash <amount> --currency <KRW|USD> [--json]
  paper account [--json]
`;

function usageFailure(message: string): CliOutcome {
  return { envelope: { ok: false, command: "usage", error: { code: "usage", message } }, exitCode: 1 };
}

async function dispatch(argv: readonly string[]): Promise<{ outcome: CliOutcome; json: boolean }> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      json: { type: "boolean", default: false },
      series: { type: "string" },
      strategy: { type: "string" },
      cash: { type: "string" },
      currency: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const json = values.json === true;
  const [group, sub] = positionals;

  if (group === "backtest" && sub === "run") {
    if (values.series === undefined || values.strategy === undefined || values.cash === undefined) {
      return { outcome: usageFailure("backtest run requires --series, --strategy and --cash"), json };
    }
    return { outcome: await runBacktestCommand({ series: values.series, strategy: values.strategy, seed: Number(values.cash) }), json };
  }
  if (group === "paper" && sub === "open") {
    if (values.cash === undefined || values.currency === undefined) {
      return { outcome: usageFailure("paper open requires --cash and --currency"), json };
    }
    return { outcome: await paperOpenCommand({ seed: Number(values.cash), currency: values.currency }), json };
  }
  if (group === "paper" && sub === "account") {
    return { outcome: await paperAccountCommand(), json };
  }
  return { outcome: usageFailure(`unknown command: ${[group, sub].filter(Boolean).join(" ") || "(none)"}`), json };
}

async function main(): Promise<void> {
  let outcome: CliOutcome;
  let json = false;
  try {
    ({ outcome, json } = await dispatch(process.argv.slice(2)));
  } catch (error) {
    // parseArgs strict failures and anything unexpected — one envelope, same shape.
    outcome = {
      envelope: { ok: false, command: "usage", error: { code: "usage", message: error instanceof Error ? error.message : String(error) } },
      exitCode: 1,
    };
    json = process.argv.includes("--json");
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(outcome.envelope)}\n`);
  } else if (outcome.envelope.ok) {
    process.stdout.write(`${JSON.stringify(outcome.envelope.result, null, 2)}\n`);
  } else {
    process.stderr.write(`${outcome.envelope.error.code}: ${outcome.envelope.error.message}\n${USAGE}`);
  }
  process.exitCode = outcome.exitCode;
}

void main();
