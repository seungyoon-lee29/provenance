import { describe, expect, it } from "vitest";

import { brandReference } from "../../src/shared/contracts/brands";
import type { InternalPaperAccountReference, PaperOrderReference } from "../../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "../../src/shared/contracts/viewer-context";
import type { PaperFill, PaperOrderPayload } from "../../src/modules/paper-trading/internal/contracts";
import { PaperJournal } from "../../src/modules/paper-trading/internal/journal";
import type { CommandDecision, PaperJournalStore } from "../../src/modules/paper-trading/internal/journal";
import { PaperTradingService } from "../../src/modules/paper-trading/internal/service";

/**
 * Behavioral contract every PaperJournalStore implementation (in-memory, pg)
 * must satisfy identically THROUGH the journal — the money boundary. The
 * durability clauses fold a journal, then hydrate a SECOND journal over the
 * same store and require the identical fold: that is the persistence half of
 * the money-conservation re-establishment (Stage 2 T2-b) — a restart may not
 * create, destroy or double-apply money.
 *
 * `makeStore` returns a fresh empty store each call (async so the pg impl can
 * truncate its tables between cases).
 */

const WS = "ws-paper-contract";
const NOW_BASE = Date.parse("2026-07-18T01:00:00.000Z");

function account(id = "acct-contract"): InternalPaperAccountReference {
  return brandReference<string, "InternalPaperAccountReference">(id);
}

function clock(): () => string {
  let tick = 0;
  return () => new Date(NOW_BASE + ++tick * 1_000).toISOString();
}

function limitBuy(quantity: number, price: number): PaperOrderPayload {
  return {
    instrument: brandReference<string, "PaperInstrumentReference">("instr:CONTRACT"),
    venue: "NASDAQ",
    session: "regular",
    side: "buy",
    orderType: "limit",
    limitPrice: { amount: price, currency: "USD" },
    quantity,
    timeInForce: "GTC",
  } as PaperOrderPayload;
}

/** Mirrors the service submit decision: reserve cash at the limit price. */
function decideBuy(payload: PaperOrderPayload, order: PaperOrderReference): (context: { state: unknown; revision: number }) => CommandDecision {
  return () => ({
    entry: {
      kind: "order_submitted",
      order,
      payload,
      acceptedAt: new Date(NOW_BASE).toISOString(),
      reservation: { kind: "cash", unitPrice: payload.limitPrice! },
    },
    order,
  });
}

function fillOf(order: PaperOrderReference, quantity: number, price: number, evidence: string): PaperFill {
  return {
    identity: brandReference<string, "PaperFillIdentity">(`fill:${String(order)}:${evidence}`),
    order,
    quantity,
    price: { amount: price, currency: "USD" },
    eventTime: new Date(NOW_BASE + 500_000).toISOString(),
    receivedAt: new Date(NOW_BASE + 500_000).toISOString(),
    evidenceReference: evidence,
    policyVersion: "simulation-v1",
  };
}

async function submitBuy(journal: PaperJournal, acct: InternalPaperAccountReference, key: string, quantity: number, price: number) {
  const revision = journal.currentRevision(WS, acct);
  const order = brandReference<string, "PaperOrderReference">(`paper-order:${String(acct)}:${revision + 1}`);
  const payload = limitBuy(quantity, price);
  return {
    order,
    outcome: await journal.appendCommand(WS, acct, "submit", { idempotencyKey: key, expectedRevision: String(revision) }, JSON.stringify({ key, quantity, price }), decideBuy(payload, order)),
  };
}

/** A service over the given store — the real production seam (open/prepare/change), not the journal directly. */
function serviceOver(store: PaperJournalStore): PaperTradingService {
  let updateCounter = 0;
  return new PaperTradingService({
    now: () => new Date(NOW_BASE).toISOString(),
    identity: { currentAuthorizationEpoch: () => "epoch:1" },
    observations: { currentObservation: () => undefined },
    policy: {
      policyVersion: "simulation-v1",
      seedCash: [{ amount: 100_000, currency: "USD" }],
      intentTtlMs: 10 * 60 * 1000,
      maxSlippageBps: 25,
    },
    updateId: () => `update:${updateCounter += 1}`,
    journalStore: store,
  });
}

function serviceViewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    workspaceReference: brandReference<string, "WorkspaceReference">(WS),
    accountReference: brandReference<string, "AccountReference">("account:contract"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
  } as WorkspaceViewerContext;
}

export function paperJournalContract(label: string, makeStore: () => Promise<PaperJournalStore>): void {
  describe(`PaperJournalStore contract [${label}]`, () => {
    it("provisions once, folds seed cash, and fixes the owning workspace at genesis", async () => {
      const store = await makeStore();
      const journal = await new PaperJournal(clock(), undefined, store).init();
      const acct = account();
      await journal.provision(WS, acct, [{ amount: 10_000, currency: "USD" }]);
      await journal.provision("ws-thief", acct, [{ amount: 999_999, currency: "USD" }]);
      expect(journal.ownerOf(acct)).toBe(WS);
      expect(journal.state(WS, acct).cash.get("USD")?.balance).toBe(10_000);
      expect(journal.state("ws-thief", acct).cash.size).toBe(0);
    });

    it("replays the §8 receipt across a restart: same key + payload → ORIGINAL outcome, diverging payload → conflict", async () => {
      const store = await makeStore();
      const journal = await new PaperJournal(clock(), undefined, store).init();
      const acct = account();
      await journal.provision(WS, acct, [{ amount: 10_000, currency: "USD" }]);
      const first = await submitBuy(journal, acct, "idem-1", 10, 100);
      expect(first.outcome.status).toBe("applied");

      const rehydrated = await new PaperJournal(clock(), undefined, store).init();
      const replay = await rehydrated.appendCommand(
        WS, acct, "submit", { idempotencyKey: "idem-1", expectedRevision: "1" }, JSON.stringify({ key: "idem-1", quantity: 10, price: 100 }),
        () => { throw new Error("a receipt replay must not re-decide"); },
      );
      expect(replay).toEqual(first.outcome);
      const conflict = await rehydrated.appendCommand(
        WS, acct, "submit", { idempotencyKey: "idem-1", expectedRevision: "1" }, JSON.stringify({ key: "idem-1", quantity: 99, price: 1 }),
        () => { throw new Error("a conflict must not re-decide"); },
      );
      expect(conflict.status).toBe("conflict");
    });

    it("keeps system events exactly-once across a restart: a redelivered fill is a duplicate no-op", async () => {
      const store = await makeStore();
      const journal = await new PaperJournal(clock(), undefined, store).init();
      const acct = account();
      await journal.provision(WS, acct, [{ amount: 10_000, currency: "USD" }]);
      const { order } = await submitBuy(journal, acct, "idem-fill", 10, 100);
      const fill = fillOf(order, 10, 100, "evidence:once");
      expect((await journal.appendSystem(WS, acct, String(fill.identity), { kind: "fill_applied", fill })).status).toBe("applied");

      const rehydrated = await new PaperJournal(clock(), undefined, store).init();
      expect((await rehydrated.appendSystem(WS, acct, String(fill.identity), { kind: "fill_applied", fill })).status).toBe("duplicate");
      // money moved exactly once: 10 × 100 out of the 10,000 seed.
      expect(rehydrated.state(WS, acct).cash.get("USD")?.balance).toBe(9_000);
      expect(rehydrated.state(WS, acct).positions.get("instr:CONTRACT")?.quantity).toBe(10);
    });

    it("restart equivalence: a hydrated journal folds the identical state, entries and revision", async () => {
      const store = await makeStore();
      const journal = await new PaperJournal(clock(), undefined, store).init();
      const acct = account();
      await journal.provision(WS, acct, [{ amount: 50_000, currency: "USD" }]);
      const a = await submitBuy(journal, acct, "eq-a", 20, 100);
      const b = await submitBuy(journal, acct, "eq-b", 5, 200);
      const fill = fillOf(a.order, 8, 99.5, "evidence:eq");
      await journal.appendSystem(WS, acct, String(fill.identity), { kind: "fill_applied", fill });
      await journal.appendCommand(
        WS, acct, "cancel", { idempotencyKey: "eq-cxl", expectedRevision: String(journal.currentRevision(WS, acct)) }, JSON.stringify({ cancel: String(b.order) }),
        () => ({ entry: { kind: "cancellation_resolved", order: b.order, resolution: "confirmed" }, order: b.order }),
      );

      const rehydrated = await new PaperJournal(clock(), undefined, store).init();
      expect(rehydrated.currentRevision(WS, acct)).toBe(journal.currentRevision(WS, acct));
      expect(rehydrated.list(WS, acct)).toEqual(journal.list(WS, acct));
      expect(rehydrated.state(WS, acct)).toEqual(journal.state(WS, acct));
      expect(rehydrated.ownerOf(acct)).toBe(WS);
      expect(rehydrated.accounts(WS)).toEqual(journal.accounts(WS));
    });

    it("SEC-09: erase shreds the workspace, survives a restart, suppresses old-epoch writes and admits a post-erasure epoch", async () => {
      const store = await makeStore();
      let epoch = 1;
      const journal = await new PaperJournal(clock(), () => epoch, store).init();
      const acct = account();
      await journal.provision(WS, acct, [{ amount: 10_000, currency: "USD" }]);
      await submitBuy(journal, acct, "erase-a", 10, 100);
      expect(await journal.eraseWorkspace(WS, 5)).toBe(2); // genesis + submit shredded

      const rehydrated = await new PaperJournal(clock(), () => epoch, store).init();
      expect(rehydrated.list(WS, acct)).toEqual([]);
      expect(rehydrated.ownerOf(acct)).toBeUndefined();
      // late replay / stale-backup write at a pre-erasure epoch → suppressed.
      await rehydrated.provision(WS, acct, [{ amount: 10_000, currency: "USD" }]);
      expect(rehydrated.ownerOf(acct)).toBeUndefined();
      expect(rehydrated.list(WS, acct)).toEqual([]);
      // a genuinely new post-erasure authorized epoch may open a fresh account.
      epoch = 6;
      await rehydrated.provision(WS, acct, [{ amount: 777, currency: "USD" }]);
      expect(rehydrated.state(WS, acct).cash.get("USD")?.balance).toBe(777);
    });

    it("fence is monotonic: a stale lower erase never rolls the watermark back", async () => {
      const store = await makeStore();
      let epoch = 1;
      const journal = await new PaperJournal(clock(), () => epoch, store).init();
      const acct = account();
      await journal.eraseWorkspace(WS, 9);
      await journal.eraseWorkspace(WS, 4);
      epoch = 5; // below the surviving high-water 9 → still suppressed
      await journal.provision(WS, acct, [{ amount: 1, currency: "USD" }]);
      expect(journal.ownerOf(acct)).toBeUndefined();
      const rehydrated = await new PaperJournal(clock(), () => 5, store).init();
      await rehydrated.provision(WS, acct, [{ amount: 1, currency: "USD" }]);
      expect(rehydrated.ownerOf(acct)).toBeUndefined();
    });

    // codex T2-b BLOCKER: a delayed LOWER erase deleted rows written at a
    // legitimately higher post-erasure epoch while GREATEST left the fence put.
    it("a delayed lower erase is a no-op: money written above the watermark survives", async () => {
      const store = await makeStore();
      let epoch = 1;
      const journal = await new PaperJournal(clock(), () => epoch, store).init();
      const acct = account();
      await journal.eraseWorkspace(WS, 9);
      epoch = 10; // a genuinely new post-erasure authorized epoch
      await journal.provision(WS, acct, [{ amount: 777, currency: "USD" }]);
      expect(journal.state(WS, acct).cash.get("USD")?.balance).toBe(777);

      expect(await journal.eraseWorkspace(WS, 4)).toBe(0); // stale erase shreds nothing
      expect(journal.state(WS, acct).cash.get("USD")?.balance).toBe(777);
      const rehydrated = await new PaperJournal(clock(), () => epoch, store).init();
      expect(rehydrated.state(WS, acct).cash.get("USD")?.balance).toBe(777);
      expect(rehydrated.ownerOf(acct)).toBe(WS);
    });

    // codex T2-b BLOCKER: two workspaces provisioning the same account id both
    // applied, seeding cash twice under one durable owner.
    it("refuses a cross-workspace genesis: an account is owned by exactly one workspace", async () => {
      const store = await makeStore();
      const acct = account("acct-contested");
      const a = await new PaperJournal(clock(), undefined, store).init();
      await a.provision("ws-a", acct, [{ amount: 10_000, currency: "USD" }]);

      // A second journal instance (no shared cache) attempts the same account id.
      const b = await new PaperJournal(clock(), undefined, store).init();
      await b.provision("ws-b", acct, [{ amount: 999_999, currency: "USD" }]);
      expect(b.state("ws-b", acct).cash.size).toBe(0);
      expect(b.ownerOf(acct)).toBe("ws-a");

      const rehydrated = await new PaperJournal(clock(), undefined, store).init();
      expect(rehydrated.ownerOf(acct)).toBe("ws-a");
      expect(rehydrated.state("ws-b", acct).cash.size).toBe(0);
      expect(rehydrated.state("ws-a", acct).cash.get("USD")?.balance).toBe(10_000);
    });

    // codex T2-b HIGH: a store that already applied the command (lost COMMIT
    // ack / a writer this cache never saw) must trigger reconciliation, not a
    // silently empty cache.
    it("reconciles when the store already has the command: the durable entry becomes visible", async () => {
      const store = await makeStore();
      const acct = account();
      const primed = await new PaperJournal(clock(), undefined, store).init();
      await primed.provision(WS, acct, [{ amount: 10_000, currency: "USD" }]);
      const first = await submitBuy(primed, acct, "lost-ack", 10, 100);
      expect(first.outcome.status).toBe("applied");

      // A stale journal that never saw the submit replays it with the same key.
      const stale = await new PaperJournal(clock(), undefined, store).init();
      await primed.provision(WS, acct, [{ amount: 10_000, currency: "USD" }]); // no-op, keeps `primed` authoritative
      const replay = await stale.appendCommand(
        WS, acct, "submit", { idempotencyKey: "lost-ack", expectedRevision: "1" }, JSON.stringify({ key: "lost-ack", quantity: 10, price: 100 }),
        () => { throw new Error("a hydrated replay must not re-decide"); },
      );
      // Hydration already carried the receipt, so this is the ORIGINAL outcome.
      expect(replay).toEqual(first.outcome);
      expect(stale.state(WS, acct).cash.get("USD")?.reserved).toBe(1_000);
    });

    // codex T2-b HIGH: a malformed event time parsed to NaN, every temporal
    // guard evaluated false, and the fill landed on a cancelled order.
    it("refuses a fill whose event time is not a real instant", async () => {
      const store = await makeStore();
      const journal = await new PaperJournal(clock(), undefined, store).init();
      const acct = account();
      await journal.provision(WS, acct, [{ amount: 10_000, currency: "USD" }]);
      const { order } = await submitBuy(journal, acct, "nan-time", 10, 100);
      const before = journal.state(WS, acct);
      const malformed = { ...fillOf(order, 1, 100, "evidence:nan"), eventTime: "not-a-date" };
      const outcome = await journal.appendSystem(WS, acct, "nan-fill", { kind: "fill_applied", fill: malformed });
      expect(outcome).toEqual({ status: "refused", reason: "invalid_fill" });
      expect(journal.state(WS, acct)).toEqual(before);
    });

    // codex T2-b HIGH: the command path could carry a server-only entry kind
    // and mint a second genesis (cash 100 → 200) with the oracle blessing it.
    it("refuses a server-only entry kind smuggled through the command path", async () => {
      const store = await makeStore();
      const journal = await new PaperJournal(clock(), undefined, store).init();
      const acct = account();
      await journal.provision(WS, acct, [{ amount: 100, currency: "USD" }]);
      await expect(journal.appendCommand(
        WS, acct, "submit", { idempotencyKey: "mint", expectedRevision: "1" }, "mint",
        () => ({
          entry: { kind: "account_opened", seedCash: [{ amount: 100, currency: "USD" }] },
          order: brandReference<string, "PaperOrderReference">("paper-order:mint"),
        } as never),
      )).rejects.toThrow(/server-only/);
      expect(journal.state(WS, acct).cash.get("USD")?.balance).toBe(100);
    });

    // codex T2-b HIGH: the journal-level restart clauses stayed green while a
    // restarted SERVICE returned a ready-but-empty shell, because the service
    // never hydrated its journal. This drives the REAL public seam.
    it("service restart: a new service over the same store serves the persisted account, not an empty shell", async () => {
      const store = await makeStore();
      const viewer = serviceViewer();
      const first = serviceOver(store);
      const opened = await first.open({ requestRevision: "r1" }, viewer).initial;
      if (opened.status !== "ready") throw new Error(`open failed: ${opened.status}`);
      const prepared = await first.prepare({ payload: limitBuy(10, 100) }, viewer);
      if (prepared.status !== "issued") throw new Error(`prepare failed: ${prepared.status}`);
      const submitted = await first.change(
        { kind: "submit", account: opened.account, intent: prepared.intent.reference },
        { idempotencyKey: "svc-1", expectedRevision: String(prepared.intent.accountRevision) },
        viewer,
      );
      expect(submitted.status).toBe("applied");

      // The sharp probe: `change` is the restarted service's FIRST call, so
      // nothing else can have hydrated the journal for it. Without hydration
      // `ownerOf` misses and the service refuses its own persisted account.
      const restarted = serviceOver(store);
      const replay = await restarted.change(
        { kind: "submit", account: opened.account, intent: prepared.intent.reference },
        { idempotencyKey: "svc-1", expectedRevision: String(prepared.intent.accountRevision) },
        viewer,
      );
      expect(replay).toEqual(submitted); // §8 receipt survived: ORIGINAL outcome

      const reopened = await restarted.open({ requestRevision: "r2" }, viewer).initial;
      if (reopened.status !== "ready") throw new Error(`reopen failed: ${reopened.status}`);
      expect(reopened.account).toEqual(opened.account);
      expect(reopened.cash.find((row) => row.currency === "USD")).toEqual({ currency: "USD", balance: 100_000, reserved: 1_000, available: 99_000 });
      expect(reopened.orders).toHaveLength(1);
    });

    // codex T2-b MEDIUM: a refresh racing ahead of `initial` observed the
    // pre-genesis empty state.
    it("service open: a refresh issued before initial still observes the provisioned account", async () => {
      const store = await makeStore();
      const load = serviceOver(store).open({ requestRevision: "r1" }, serviceViewer());
      const update = await load.refresh("orders"); // deliberately NOT awaiting initial first
      expect(update).toBeDefined();
      const shell = await load.initial;
      if (shell.status !== "ready") throw new Error(`open failed: ${shell.status}`);
      expect(update?.accountRevisions[String(shell.account)]).toBe(1); // genesis already folded
    });

    // codex T2-b MEDIUM: a confirmed-cancelled odd-lot order vetoed a split the
    // fold would not have applied to it anyway.
    it("a confirmed-cancelled order does not veto a split of the live position", async () => {
      const store = await makeStore();
      const journal = await new PaperJournal(clock(), undefined, store).init();
      const acct = account();
      await journal.provision(WS, acct, [{ amount: 10_000, currency: "USD" }]);
      // Hold 2 shares.
      const held = await submitBuy(journal, acct, "split-hold", 2, 100);
      const fill = fillOf(held.order, 2, 100, "evidence:hold");
      await journal.appendSystem(WS, acct, String(fill.identity), { kind: "fill_applied", fill });
      // A cancelled 1-share order remains in the journal.
      const odd = await submitBuy(journal, acct, "split-odd", 1, 100);
      await journal.appendCommand(
        WS, acct, "cancel", { idempotencyKey: "split-odd-cxl", expectedRevision: String(journal.currentRevision(WS, acct)) }, "cxl",
        () => ({ entry: { kind: "cancellation_resolved", order: odd.order, resolution: "confirmed" }, order: odd.order }),
      );

      const split = await journal.appendSystem(WS, acct, "action:reverse", {
        kind: "corporate_action_applied",
        action: brandReference<string, "PaperCorporateActionReference">("action:reverse"),
        instrument: brandReference<string, "PaperInstrumentReference">("instr:CONTRACT"),
        adjustment: { kind: "split", numerator: 1, denominator: 2 },
      });
      expect(split.status).toBe("applied");
      expect(journal.state(WS, acct).positions.get("instr:CONTRACT")?.quantity).toBe(1);
    });
  });
}
