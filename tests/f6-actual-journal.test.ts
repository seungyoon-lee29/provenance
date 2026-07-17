import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { ActualJournal } from "../src/modules/actual-portfolio/baseline/journal";
import type {
  ActualAccountReference,
  ActualPortfolioCommand,
} from "../src/modules/actual-portfolio/baseline/contracts";

const NOW = "2026-07-17T06:00:00.000Z";
const WS = "workspace:w1";
const ACCOUNT = brandReference<string, "ActualAccountReference">("actual-account:a1") as ActualAccountReference;

function journal(): ActualJournal {
  return new ActualJournal(() => NOW);
}

function openingCommand(overrides: Partial<{ quantity: number; instrument: string }> = {}): ActualPortfolioCommand {
  return {
    kind: "record_opening_position",
    account: ACCOUNT,
    position: {
      instrument: brandReference<string, "ActualInstrumentReference">(overrides.instrument ?? "instr:AAPL"),
      signedQuantity: overrides.quantity ?? 10,
      currency: "USD",
      asOf: "2026-07-01",
      source: brandReference<string, "ActualSourceReference">("source:manual-entry:1"),
      sourceCostBasis: { amount: 1500, currency: "USD", includesFees: false },
    },
  };
}

function activityCommand(): ActualPortfolioCommand {
  return {
    kind: "record_activity",
    account: ACCOUNT,
    activity: {
      activityKind: "cash_deposit",
      signedCashAmount: { amount: 1_000_000, currency: "KRW" },
      occurredAt: "2026-07-10",
      source: brandReference<string, "ActualSourceReference">("source:manual-entry:2"),
    },
  };
}

const control = (key: string, revision: number) => ({ idempotencyKey: key, expectedRevision: String(revision) });

describe("append-only Actual journal (spec §8, invariant 1)", () => {
  it("records an opening position as an aggregate lot with provenance at revision 1", () => {
    const j = journal();
    const outcome = j.append(WS, openingCommand(), control("k1", 0));
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") throw new Error("unreachable");
    expect(outcome.revision).toBe(1);
    const entries = j.list(WS, ACCOUNT);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("opening_position");
    if (entries[0]?.kind === "opening_position") {
      // The synthetic aggregate lot keeps its source/as-of and NO derived history.
      expect(entries[0].position.asOf).toBe("2026-07-01");
      expect(String(entries[0].position.source)).toBe("source:manual-entry:1");
      expect(JSON.stringify(entries[0])).not.toMatch(/realized|taxLot|holdingPeriod/i);
    }
  });

  it("keeps revisions contiguous across command kinds", () => {
    const j = journal();
    j.append(WS, openingCommand(), control("k1", 0));
    j.append(WS, activityCommand(), control("k2", 1));
    const third = j.append(WS, openingCommand({ instrument: "instr:MSFT" }), control("k3", 2));
    expect(third).toMatchObject({ status: "applied", revision: 3 });
    expect(j.currentRevision(WS, ACCOUNT)).toBe(3);
    expect(j.list(WS, ACCOUNT).map((entry) => entry.revision)).toEqual([1, 2, 3]);
  });

  it("supersedes an entry by appending — the original row never mutates", () => {
    const j = journal();
    const first = j.append(WS, openingCommand(), control("k1", 0));
    if (first.status !== "applied") throw new Error("expected applied");
    const replacementSource = openingCommand({ quantity: 12 });
    if (replacementSource.kind !== "record_opening_position") throw new Error("unreachable");
    const supersede = j.append(WS, {
      kind: "supersede_entry",
      account: ACCOUNT,
      target: first.entryReference,
      replacement: { kind: "opening_position", position: replacementSource.position },
    }, control("k2", 1));
    expect(supersede).toMatchObject({ status: "applied", revision: 2 });
    const entries = j.list(WS, ACCOUNT);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe("opening_position");
    if (entries[0]?.kind === "opening_position") expect(entries[0].position.signedQuantity).toBe(10);
    expect(entries[1]?.kind).toBe("superseding");
    if (entries[1]?.kind === "superseding") expect(String(entries[1].supersedes)).toBe(String(first.entryReference));
  });

  it("reverses an entry by appending and refuses an unknown target with zero side effects", () => {
    const j = journal();
    const first = j.append(WS, openingCommand(), control("k1", 0));
    if (first.status !== "applied") throw new Error("expected applied");
    const reversal = j.append(WS, { kind: "reverse_entry", account: ACCOUNT, target: first.entryReference, reason: "entered in error" }, control("k2", 1));
    expect(reversal).toMatchObject({ status: "applied", revision: 2 });

    const unknown = j.append(WS, {
      kind: "reverse_entry",
      account: ACCOUNT,
      target: brandReference<string, "ActualJournalEntryReference">("actual-entry:nope"),
      reason: "x",
    }, control("k3", 2));
    expect(unknown).toEqual({ status: "refused", reason: "unknown_entry" });
    expect(j.list(WS, ACCOUNT)).toHaveLength(2);
    expect(j.currentRevision(WS, ACCOUNT)).toBe(2);
  });
});

describe("command idempotency (spec §8, invariant 2)", () => {
  it("replays the exact receipt for the same key and canonical payload without a second write", () => {
    const j = journal();
    const first = j.append(WS, openingCommand(), control("k1", 0));
    const replay = j.append(WS, openingCommand(), control("k1", 0));
    expect(replay).toEqual(first);
    expect(j.list(WS, ACCOUNT)).toHaveLength(1);
    expect(j.currentRevision(WS, ACCOUNT)).toBe(1);
  });

  it("returns a side-effect-free conflict for the same key with a different payload", () => {
    const j = journal();
    j.append(WS, openingCommand(), control("k1", 0));
    const conflict = j.append(WS, openingCommand({ quantity: 99 }), control("k1", 0));
    expect(conflict).toEqual({ status: "conflict" });
    expect(j.list(WS, ACCOUNT)).toHaveLength(1);
  });

  it("rejects a stale expected revision with the current revision and zero side effects", () => {
    const j = journal();
    j.append(WS, openingCommand(), control("k1", 0));
    const stale = j.append(WS, activityCommand(), control("k2", 0));
    expect(stale).toEqual({ status: "rejected", currentRevision: 1 });
    expect(j.list(WS, ACCOUNT)).toHaveLength(1);
  });

  it("scopes idempotency by command kind: the same key on a different kind is a fresh command", () => {
    const j = journal();
    j.append(WS, openingCommand(), control("shared-key", 0));
    const second = j.append(WS, activityCommand(), control("shared-key", 1));
    expect(second).toMatchObject({ status: "applied", revision: 2 });
  });
});

describe("workspace and account isolation (SEC-01 ground layer)", () => {
  it("journals are invisible across workspaces even for the same account reference", () => {
    const j = journal();
    j.append(WS, openingCommand(), control("k1", 0));
    expect(j.list("workspace:w2", ACCOUNT)).toHaveLength(0);
    expect(j.currentRevision("workspace:w2", ACCOUNT)).toBe(0);
    // Same account name in another workspace starts its own contiguous history.
    const other = j.append("workspace:w2", openingCommand(), control("k1", 0));
    expect(other).toMatchObject({ status: "applied", revision: 1 });
    expect(j.list(WS, ACCOUNT)).toHaveLength(1);
  });

  it("accounts within a workspace keep independent revision streams", () => {
    const j = journal();
    const accountB = brandReference<string, "ActualAccountReference">("actual-account:b1") as ActualAccountReference;
    j.append(WS, openingCommand(), control("k1", 0));
    const b = j.append(WS, { ...openingCommand(), account: accountB }, control("k1", 0));
    expect(b).toMatchObject({ status: "applied", revision: 1 });
    expect(j.currentRevision(WS, ACCOUNT)).toBe(1);
    expect(j.currentRevision(WS, accountB)).toBe(1);
  });
});

describe("SEC-09: erasure is the only removal path and nothing regenerates", () => {
  it("erase shreds entries and receipts; late replay and old-epoch appends are suppressed", () => {
    const j = journal();
    j.append(WS, openingCommand(), control("k1", 0));
    j.append(WS, activityCommand(), control("k2", 1));
    expect(j.eraseWorkspace(WS, 1)).toBeGreaterThan(0);
    expect(j.list(WS, ACCOUNT)).toHaveLength(0);

    // A replayed pre-erasure command must not resurrect the receipt or the row.
    const replay = j.append(WS, openingCommand(), control("k1", 0));
    expect(replay).toEqual({ status: "suppressed" });
    expect(j.list(WS, ACCOUNT)).toHaveLength(0);
    // Another workspace is untouched.
    const other = j.append("workspace:w2", openingCommand(), control("k9", 0));
    expect(other).toMatchObject({ status: "applied" });
  });
});
