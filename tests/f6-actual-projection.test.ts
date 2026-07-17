import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { ActualJournal } from "../src/modules/actual-portfolio/baseline/journal";
import type {
  ActualAccountReference,
  ActualInstrumentReference,
  ActualPortfolioCommand,
  OpeningPosition,
} from "../src/modules/actual-portfolio/baseline/contracts";
import { effectiveRecords } from "../src/modules/actual-portfolio/baseline/projection";
import { presentPositionsSection } from "../src/modules/actual-portfolio/baseline/valuation";
import type { ActualPriceFxPort } from "../src/modules/actual-portfolio/baseline/valuation";

const NOW = "2026-07-17T06:00:00.000Z";
const WS = "workspace:w1";
const ACCOUNT = brandReference<string, "ActualAccountReference">("actual-account:a1") as ActualAccountReference;

const instr = (symbol: string): ActualInstrumentReference =>
  brandReference<string, "ActualInstrumentReference">(`instr:${symbol}`);

function opening(symbol: string, quantity: number, currency = "USD"): OpeningPosition {
  return {
    instrument: instr(symbol),
    signedQuantity: quantity,
    currency,
    asOf: "2026-07-01",
    source: brandReference<string, "ActualSourceReference">(`source:manual:${symbol}`),
    sourceCostBasis: { amount: quantity * 100, currency, includesFees: false },
  };
}

function openingCommand(symbol: string, quantity: number, currency = "USD"): ActualPortfolioCommand {
  return { kind: "record_opening_position", account: ACCOUNT, position: opening(symbol, quantity, currency) };
}

const control = (key: string, revision: number) => ({ idempotencyKey: key, expectedRevision: String(revision) });

function seeded() {
  const journal = new ActualJournal(() => NOW);
  const first = journal.append(WS, openingCommand("AAPL", 10), control("k1", 0));
  if (first.status !== "applied") throw new Error("seed failed");
  return { journal, firstRef: first.entryReference };
}

describe("effective record projection (append-only corrections resolve, source rows preserved)", () => {
  it("projects opening/manual/activity rows and flags the opening row as an aggregate lot", () => {
    const { journal } = seeded();
    journal.append(WS, {
      kind: "record_manual_position",
      account: ACCOUNT,
      position: { ...opening("MSFT", 5), completeness: "complete" },
    }, control("k2", 1));
    journal.append(WS, {
      kind: "record_activity",
      account: ACCOUNT,
      activity: { activityKind: "cash_deposit", signedCashAmount: { amount: 1_000_000, currency: "KRW" }, occurredAt: "2026-07-10", source: brandReference<string, "ActualSourceReference">("source:manual:dep") },
    }, control("k3", 2));

    const records = effectiveRecords(journal.list(WS, ACCOUNT));
    expect(records).toHaveLength(3);
    expect(records[0]?.payload.kind).toBe("opening_position");
    expect(records[0]?.aggregateLot).toBe(true);
    expect(records[1]?.aggregateLot).toBe(false);
    expect(records[2]?.payload.kind).toBe("portfolio_activity");
  });

  it("a superseded row projects its replacement while the source row stays in the journal", () => {
    const { journal, firstRef } = seeded();
    journal.append(WS, {
      kind: "supersede_entry",
      account: ACCOUNT,
      target: firstRef,
      replacement: { kind: "opening_position", position: opening("AAPL", 12) },
    }, control("k2", 1));

    const records = effectiveRecords(journal.list(WS, ACCOUNT));
    expect(records).toHaveLength(1);
    expect(records[0]?.payload.kind === "opening_position" && records[0].payload.position.signedQuantity).toBe(12);
    expect(journal.list(WS, ACCOUNT)).toHaveLength(2);
  });

  it("a reversed row disappears from the projection", () => {
    const { journal, firstRef } = seeded();
    journal.append(WS, { kind: "reverse_entry", account: ACCOUNT, target: firstRef, reason: "error" }, control("k2", 1));
    expect(effectiveRecords(journal.list(WS, ACCOUNT))).toHaveLength(0);
  });

  it("reversing a superseding entry restores the original row", () => {
    const { journal, firstRef } = seeded();
    const supersede = journal.append(WS, {
      kind: "supersede_entry",
      account: ACCOUNT,
      target: firstRef,
      replacement: { kind: "opening_position", position: opening("AAPL", 12) },
    }, control("k2", 1));
    if (supersede.status !== "applied") throw new Error("expected applied");
    journal.append(WS, { kind: "reverse_entry", account: ACCOUNT, target: supersede.entryReference, reason: "undo" }, control("k3", 2));

    const records = effectiveRecords(journal.list(WS, ACCOUNT));
    expect(records).toHaveLength(1);
    expect(records[0]?.payload.kind === "opening_position" && records[0].payload.position.signedQuantity).toBe(10);
  });

  it("journal refuses a second correction on the same target and any correction of a reversal", () => {
    const { journal, firstRef } = seeded();
    const reversal = journal.append(WS, { kind: "reverse_entry", account: ACCOUNT, target: firstRef, reason: "error" }, control("k2", 1));
    if (reversal.status !== "applied") throw new Error("expected applied");

    const second = journal.append(WS, {
      kind: "supersede_entry",
      account: ACCOUNT,
      target: firstRef,
      replacement: { kind: "opening_position", position: opening("AAPL", 11) },
    }, control("k3", 2));
    expect(second).toEqual({ status: "refused", reason: "already_corrected" });

    const reverseReversal = journal.append(WS, { kind: "reverse_entry", account: ACCOUNT, target: reversal.entryReference, reason: "x" }, control("k4", 2));
    expect(reverseReversal).toEqual({ status: "refused", reason: "already_corrected" });
    expect(journal.list(WS, ACCOUNT)).toHaveLength(2);
  });
});

const QUOTES: Record<string, { amount: number; currency: string }> = {
  "instr:AAPL": { amount: 200, currency: "USD" },
  "instr:SSNLF": { amount: 70_000, currency: "KRW" },
};

function port(overrides: { missingPrice?: string[]; missingFx?: boolean } = {}): ActualPriceFxPort {
  return {
    quote(instrument) {
      const key = String(instrument);
      if (overrides.missingPrice?.includes(key)) return { available: false };
      const quote = QUOTES[key];
      return quote === undefined
        ? { available: false }
        : { available: true, unitPrice: quote, asOf: NOW };
    },
    fxRate(from, to) {
      if (from === to) return { available: true, rate: 1, asOf: NOW };
      if (overrides.missingFx) return { available: false };
      if (from === "USD" && to === "KRW") return { available: true, rate: 1_400, asOf: NOW };
      return { available: false };
    },
  };
}

function positionsOf(journal: ActualJournal) {
  return effectiveRecords(journal.list(WS, ACCOUNT));
}

describe("valuation section completeness (UF-06: no promotion of subtotals, no estimated totals)", () => {
  it("complete: every position valued -> KRW total and per-row weights", () => {
    const { journal } = seeded(); // AAPL 10 @200 USD -> 2000 USD -> 2,800,000 KRW
    journal.append(WS, openingCommand("SSNLF", 10, "KRW"), control("k2", 1)); // 700,000 KRW
    const section = presentPositionsSection(positionsOf(journal), port(), "KRW");
    expect(section.completeness).toBe("complete");
    if (section.completeness !== "complete") throw new Error("unreachable");
    expect(section.total).toEqual({ amount: 3_500_000, currency: "KRW" });
    expect(section.rows).toHaveLength(2);
    const weights = section.rows.map((row) => row.weight);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("partial: a missing price yields known subtotal + missing list and NO total/weight fields", () => {
    const { journal } = seeded();
    journal.append(WS, openingCommand("SSNLF", 10, "KRW"), control("k2", 1));
    const section = presentPositionsSection(positionsOf(journal), port({ missingPrice: ["instr:AAPL"] }), "KRW");
    expect(section.completeness).toBe("partial");
    if (section.completeness !== "partial") throw new Error("unreachable");
    expect(section.knownSubtotal).toEqual({ amount: 700_000, currency: "KRW" });
    expect(section.missing).toEqual([{ instrument: "instr:AAPL", reason: "price" }]);
    expect("total" in section).toBe(false);
    expect(JSON.stringify(section)).not.toContain("weight");
  });

  it("partial: a missing FX keeps the original-currency value visible and lists the fx gap", () => {
    const { journal } = seeded();
    journal.append(WS, openingCommand("SSNLF", 10, "KRW"), control("k2", 1));
    const section = presentPositionsSection(positionsOf(journal), port({ missingFx: true }), "KRW");
    expect(section.completeness).toBe("partial");
    if (section.completeness !== "partial") throw new Error("unreachable");
    expect(section.missing).toEqual([{ instrument: "instr:AAPL", reason: "fx" }]);
    const appleRow = section.rows.find((row) => row.instrument === "instr:AAPL");
    expect(appleRow?.originalValue).toEqual({ amount: 2_000, currency: "USD" });
    expect(appleRow?.reportingValue).toBeUndefined();
  });

  it("unavailable: nothing valued -> missing list only, no subtotal, no total", () => {
    const { journal } = seeded();
    const section = presentPositionsSection(positionsOf(journal), port({ missingPrice: ["instr:AAPL"] }), "KRW");
    expect(section.completeness).toBe("unavailable");
    if (section.completeness !== "unavailable") throw new Error("unreachable");
    expect(section.missing).toHaveLength(1);
    expect(JSON.stringify(section)).not.toMatch(/total|subtotal|weight/i);
  });

  it("never produces a rebalancing proposal or derived history anywhere in the view", () => {
    const { journal } = seeded();
    journal.append(WS, openingCommand("SSNLF", 10, "KRW"), control("k2", 1));
    for (const p of [port(), port({ missingPrice: ["instr:AAPL"] }), port({ missingFx: true })]) {
      const section = presentPositionsSection(positionsOf(journal), p, "KRW");
      expect(JSON.stringify(section)).not.toMatch(/rebalanc|proposal|realized|taxLot|twr|xirr/i);
    }
  });

  it("keeps aggregate-lot marking and provenance on valued rows", () => {
    const { journal } = seeded();
    const section = presentPositionsSection(positionsOf(journal), port(), "KRW");
    if (section.completeness === "unavailable") throw new Error("expected rows");
    const row = section.rows[0];
    expect(row?.aggregateLot).toBe(true);
    expect(row?.asOf).toBe("2026-07-01");
    expect(row?.source).toBe("source:manual:AAPL");
  });
});
