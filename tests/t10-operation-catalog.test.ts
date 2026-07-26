import { describe, expect, it } from "vitest";

import { runBacktestCommand, STRATEGY_MODULE_FLAG, strategyDescribeCommand, strategyListCommand } from "../src/cli/commands";
import { operationCatalog } from "../src/operations/catalog";

/**
 * T10 S2 slice regression (progress/t10-strategy-cli-mcp.md).
 *
 * Two contracts carry this slice:
 *   1. The catalog never flattens a domain outcome. A refused backtest is an
 *      `ok` operation whose value carries the typed refusal — the agent-facing
 *      differentiator of ticket 41. Only input problems refuse at the operation
 *      layer, and they refuse with a reason an agent can branch on.
 *   2. Arbitrary-module strategy loading is off unless explicitly enabled, at
 *      the CLI boundary — because an agent can drive the CLI, so excluding
 *      module paths from the MCP catalog alone contains nothing.
 *
 * Blind acceptance authorship is a separate agent at the tier-top gate.
 */

const SERIES = {
  instrument: "instr:BT",
  venue: "KRX",
  currency: "KRW",
  bars: [
    { periodStart: "2026-01-05T06:30:00.000Z", close: 10_000, volume: 1_000_000, complete: true },
    { periodStart: "2026-01-06T06:30:00.000Z", close: 10_500, volume: 1_000_000, complete: true },
    { periodStart: "2026-01-07T06:30:00.000Z", close: 11_000, volume: 1_000_000, complete: true },
  ],
};

const catalog = operationCatalog();

function expectOk(result: Awaited<ReturnType<typeof catalog.call>>): Record<string, unknown> {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result.value as Record<string, unknown>;
}

describe("T10 S2 — operation catalog", () => {
  it("classifies every operation and exposes none that writes", () => {
    const names = catalog.list().map((operation) => operation.name);
    expect(names).toContain("backtest.run");
    expect(names).toContain("paper.account");
    // A money genesis is a write; ticket 41 keeps writes off the agent surface
    // until the confirm token lands (T11).
    expect(names).not.toContain("paper.open");
    for (const operation of catalog.list()) {
      expect(["read", "compute"]).toContain(operation.kind);
    }
  });

  it("refuses an unknown operation by name rather than throwing", async () => {
    const result = await catalog.call("backtest.nuke", {});
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("unknown_operation");
  });

  it("passes a refused backtest through WHOLE — the typed reason survives", async () => {
    const value = expectOk(
      await catalog.call("backtest.run", {
        series: { ...SERIES, bars: [] },
        strategy: { name: "buy_and_hold" },
        cash: 1_000_000,
      }),
    );
    // Operation-level success, domain-level refusal with its reason intact.
    expect(value.outcome).toEqual({ status: "refused", reason: "empty_series" });
  });

  it("distinguishes an unknown strategy from bad parameters", async () => {
    const unknown = await catalog.call("backtest.run", { series: SERIES, strategy: { name: "moon" }, cash: 1_000 });
    const bad = await catalog.call("backtest.run", { series: SERIES, strategy: { name: "sma_cross", params: { fast: 9, slow: 2 } }, cash: 1_000 });
    const shape = await catalog.call("backtest.run", { series: SERIES, strategy: { name: "buy_and_hold" }, cash: -5 });
    expect([unknown, bad, shape].map((result) => (result.status === "refused" ? result.reason : "ok"))).toEqual([
      "unknown_strategy",
      "invalid_params",
      "invalid_input",
    ]);
  });

  it("discloses the effective strategy and params alongside the report", async () => {
    const value = expectOk(await catalog.call("backtest.run", { series: SERIES, strategy: { name: "buy_and_hold" }, cash: 1_000_000 }));
    // `cashFraction` was never supplied — the disclosure reports what RAN.
    expect(value.strategy).toEqual({ name: "buy_and_hold", params: { cashFraction: 0.95 } });
    expect((value.outcome as { status: string }).status).toBe("complete");
  });

  it("dry run resolves and discloses without executing", async () => {
    const value = expectOk(
      await catalog.call("backtest.run", { series: SERIES, strategy: { name: "sma_cross", params: { fast: 2, slow: 3 } }, cash: 500_000, dryRun: true }),
    );
    expect(value.dryRun).toBe(true);
    expect(value.outcome).toBeUndefined();
    expect(value.strategy).toEqual({ name: "sma_cross", params: { fast: 2, slow: 3, cashFraction: 0.95 } });
    expect(value.series).toMatchObject({ barCount: 3, priceBasis: "raw", taxClass: null });
  });

  it("paper.account reports honestly when no database is configured (never throws)", async () => {
    const result = await operationCatalog().call("paper.account", {});
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    // NOT `unavailable`: "configure something and call again" and "the dependency
    // is down" are different next actions, and an agent must tell them apart from
    // the reason alone — never from the message prose (T10 S4).
    expect(result.reason).toBe("configuration_required");
  });

  it("describe publishes a JSON Schema whose defaulted fields are optional", async () => {
    const value = expectOk(await catalog.call("strategy.describe", { name: "sma_cross" }));
    const schema = value.params as { required?: readonly string[]; additionalProperties?: boolean };
    expect(schema.required).toEqual(["fast", "slow"]);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("T10 S2 — CLI transport over the catalog", () => {
  it("strategy list / describe reach the same definitions the catalog holds", async () => {
    const listed = await strategyListCommand();
    if (!listed.envelope.ok) throw new Error("expected ok");
    const { strategies } = listed.envelope.result as { strategies: readonly { name: string }[] };
    expect(strategies.map((entry) => entry.name)).toContain("sma_cross");

    const described = await strategyDescribeCommand("nope");
    expect(described.exitCode).toBe(1);
    expect(described.envelope.ok).toBe(false);
  });

  it("refuses --strategy-module unless the flag is exactly \"true\"", async () => {
    const args = { series: "/nonexistent.json", strategyModule: "/tmp/x.ts", cash: 1_000 };
    for (const value of [undefined, "false", "1", "TRUE", "true "]) {
      const outcome = await runBacktestCommand(args, value === undefined ? {} : { [STRATEGY_MODULE_FLAG]: value });
      expect(outcome.envelope.ok).toBe(false);
      if (outcome.envelope.ok) throw new Error("unreachable");
      // Refused BEFORE the series file is read — the gate precedes all IO.
      expect(outcome.envelope.error.code).toBe("refused");
      expect(outcome.envelope.error.message).toContain(STRATEGY_MODULE_FLAG);
    }
  });

  it("rejects giving both or neither strategy form", async () => {
    const both = await runBacktestCommand({ series: "/s.json", strategy: "buy_and_hold", strategyModule: "/m.ts", cash: 1 });
    const neither = await runBacktestCommand({ series: "/s.json", cash: 1 });
    for (const outcome of [both, neither]) {
      expect(outcome.exitCode).toBe(1);
      if (outcome.envelope.ok) throw new Error("unreachable");
      expect(outcome.envelope.error.code).toBe("usage");
    }
  });
});
