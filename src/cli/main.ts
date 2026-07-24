import { parseArgs } from "node:util";

import { paperAccountCommand, paperOpenCommand, runBacktestCommand } from "./commands";
import type { CliOutcome } from "./commands";

/**
 * T8 S2 — CLI entry. Run via `npm run cli -- <command> ...` (tsx); packaged
 * bin/npm-publish shape is the Stage 3 release re-definition. This file owns
 * the streams: stdout carries EXACTLY the command output (single-line
 * envelope with --json, pretty result without), everything else — usage,
 * human-facing errors — goes to stderr. Exit codes: 0 success · 1
 * general/usage/refused · 2 API/infra · 3 auth (reserved).
 */

const USAGE = `provenance — 한국 시장 백테스트 + 모의투자 엔진 (T8 S2 골격)

  backtest run --series <file.json> --strategy <file.ts> --seed <amount> [--json]
  paper open --seed <amount> --currency <KRW|USD> [--json]
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
      seed: { type: "string" },
      currency: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const json = values.json === true;
  const [group, sub] = positionals;

  if (group === "backtest" && sub === "run") {
    if (values.series === undefined || values.strategy === undefined || values.seed === undefined) {
      return { outcome: usageFailure("backtest run requires --series, --strategy and --seed"), json };
    }
    return { outcome: await runBacktestCommand({ series: values.series, strategy: values.strategy, seed: Number(values.seed) }), json };
  }
  if (group === "paper" && sub === "open") {
    if (values.seed === undefined || values.currency === undefined) {
      return { outcome: usageFailure("paper open requires --seed and --currency"), json };
    }
    return { outcome: await paperOpenCommand({ seed: Number(values.seed), currency: values.currency }), json };
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
