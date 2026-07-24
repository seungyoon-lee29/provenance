import { fileURLToPath } from "node:url";

import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { paperAccountCommand, paperOpenCommand, runBacktestCommand } from "../src/cli/commands";

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
  it("backtest run: fixture series + strategy → ok envelope with the S1 report (fill literal 10,006)", async () => {
    const { envelope, exitCode } = await runBacktestCommand({
      series: fixture("synthetic-series.json"),
      strategy: fixture("buy-once.strategy.ts"),
      seed: 1_000_000,
    });
    expect(exitCode).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    const report = envelope.result as { status: string; mode: string; fillCount: number; cash: readonly { balance: number }[] };
    expect(report.status).toBe("complete");
    expect(report.mode).toBe("approximate");
    expect(report.fillCount).toBe(1);
    expect(report.cash[0]!.balance).toBe(1_000_000 - 10 * 10_006);
  });

  it("backtest run: missing series file → usage failure, exit 1, same envelope shape", async () => {
    const { envelope, exitCode } = await runBacktestCommand({
      series: fixture("does-not-exist.json"),
      strategy: fixture("buy-once.strategy.ts"),
      seed: 1_000_000,
    });
    expect(exitCode).toBe(1);
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error("expected failure");
    expect(envelope.error.code).toBe("usage");
  });

  it("backtest run: non-positive seed refused before any file IO", async () => {
    const { envelope, exitCode } = await runBacktestCommand({
      series: fixture("synthetic-series.json"),
      strategy: fixture("buy-once.strategy.ts"),
      seed: 0,
    });
    expect(exitCode).toBe(1);
    expect(envelope.ok).toBe(false);
  });

  it("backtest run: strategy module without a function export → usage failure", async () => {
    const { envelope, exitCode } = await runBacktestCommand({
      series: fixture("synthetic-series.json"),
      strategy: fixture("synthetic-series.json"),
      seed: 1_000_000,
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
});
