import { fileURLToPath } from "node:url";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { paperAccountCommand, paperOpenCommand, runBacktestCommand, STRATEGY_MODULE_FLAG } from "../src/cli/commands";

/**
 * T8 S2 acceptance — handler-level (network-off, no process spawn): one
 * envelope shape for success and failure, exit-code mapping, fail-closed
 * series/strategy loading, and paper commands classifying an unreachable
 * database as an API error (exit 2) instead of crashing. Durable PG happy
 * paths belong to the pg lane (S2 잔여, progress/t8-backtest-engine.md).
 */

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/t8/${name}`, import.meta.url));

/** A pool whose every use rejects — deterministic "database unreachable". */
const unreachablePool = {
  connect: () => Promise.reject(new Error("connection refused (stub)")),
  query: () => Promise.reject(new Error("connection refused (stub)")),
} as unknown as Pool;

describe("T8 S2 CLI handlers", () => {
  // T10 S2: --strategy-module is opt-in (BACKTEST_STRATEGY_MODULE_ENABLED).
  // These T8 cases exercise that path, so the flag is enabled for them only.
  beforeAll(() => {
    process.env[STRATEGY_MODULE_FLAG] = "true";
  });
  afterAll(() => {
    delete process.env[STRATEGY_MODULE_FLAG];
  });

  it("backtest run: fixture series + strategy → ok envelope with the S1 report (fill literal 10,006)", async () => {
    const { envelope, exitCode } = await runBacktestCommand({
      series: fixture("synthetic-series.json"),
      strategyModule: fixture("buy-once.strategy.ts"),
      cash: 1_000_000,
    });
    expect(exitCode).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    // T10 S2: the result discloses WHICH strategy produced the report alongside
    // the report itself, so the outcome moved under `outcome`.
    const { outcome: report } = envelope.result as {
      outcome: { status: string; mode: string; fillCount: number; cash: readonly { balance: number }[] };
    };
    expect(report.status).toBe("complete");
    expect(report.mode).toBe("approximate");
    expect(report.fillCount).toBe(1);
    expect(report.cash[0]!.balance).toBe(1_000_000 - 10 * 10_006);
  });

  it("backtest run: missing series file → usage failure, exit 1, same envelope shape", async () => {
    const { envelope, exitCode } = await runBacktestCommand({
      series: fixture("does-not-exist.json"),
      strategyModule: fixture("buy-once.strategy.ts"),
      cash: 1_000_000,
    });
    expect(exitCode).toBe(1);
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error("expected failure");
    expect(envelope.error.code).toBe("usage");
  });

  it("backtest run: non-positive seed refused before any file IO", async () => {
    const { envelope, exitCode } = await runBacktestCommand({
      series: fixture("synthetic-series.json"),
      strategyModule: fixture("buy-once.strategy.ts"),
      cash: 0,
    });
    expect(exitCode).toBe(1);
    expect(envelope.ok).toBe(false);
  });

  it("backtest run: strategy module without a function export → usage failure", async () => {
    const { envelope, exitCode } = await runBacktestCommand({
      series: fixture("synthetic-series.json"),
      strategyModule: fixture("synthetic-series.json"),
      cash: 1_000_000,
    });
    expect(exitCode).toBe(1);
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error("expected failure");
    expect(envelope.error.code).toBe("usage");
  });

  it("paper open: unreachable database → api error envelope, exit 2 (never a crash)", async () => {
    const { envelope, exitCode } = await paperOpenCommand({ seed: 1_000_000, currency: "KRW" }, { pool: unreachablePool });
    expect(exitCode).toBe(2);
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error("expected failure");
    expect(envelope.error.code).toBe("api");
  });

  it("paper account: unreachable database → api error envelope, exit 2", async () => {
    const { envelope, exitCode } = await paperAccountCommand({ pool: unreachablePool });
    expect(exitCode).toBe(2);
    expect(envelope.ok).toBe(false);
  });

  it("paper open: usage guards run before touching the database", async () => {
    expect((await paperOpenCommand({ seed: -1, currency: "KRW" }, { pool: unreachablePool })).exitCode).toBe(1);
    expect((await paperOpenCommand({ seed: 1, currency: "EUR" }, { pool: unreachablePool })).exitCode).toBe(1);
  });

  // ── codex adversarial gate regressions (2026-07-25) ──

  it("SEC-05: a database error carrying a connection URI never leaks credentials into the envelope", async () => {
    const leakyPool = {
      connect: () => Promise.reject(new Error("connect ECONNREFUSED postgresql://alice:swordfish@db.internal:5432/provenance")),
      query: () => Promise.reject(new Error("connect ECONNREFUSED postgresql://alice:swordfish@db.internal:5432/provenance")),
    } as unknown as Pool;
    for (const outcome of [await paperOpenCommand({ seed: 1_000, currency: "KRW" }, { pool: leakyPool }), await paperAccountCommand({ pool: leakyPool })]) {
      expect(outcome.exitCode).toBe(2);
      expect(JSON.stringify(outcome.envelope)).not.toContain("swordfish");
      expect(JSON.stringify(outcome.envelope)).not.toContain("db.internal");
    }
  });

  it("backtest run: a series with fractional/negative bar volume is rejected at the schema boundary (usage/1)", async () => {
    const badVolume = fileURLToPath(new URL("./fixtures/t8/bad-volume-series.json", import.meta.url));
    const { envelope, exitCode } = await runBacktestCommand({ series: badVolume, strategyModule: fixture("buy-once.strategy.ts"), cash: 1_000_000 });
    expect(exitCode).toBe(1);
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error("expected failure");
    expect(envelope.error.code).toBe("usage");
  });
});
