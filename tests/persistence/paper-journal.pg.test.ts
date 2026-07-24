import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { brandReference } from "../../src/shared/contracts/brands";
import { toMinorUnits } from "../../src/modules/paper-trading/internal/contracts";
import { PaperJournal } from "../../src/modules/paper-trading/internal/journal";
import { PgPaperJournalStore } from "../../src/modules/paper-trading/internal/journal-store.pg";
import { decideBuy, limitBuy, paperJournalContract } from "./paper-journal-contract";

// Runs only in the compose persistence-integration profile (real postgres +
// migrated schema). The network-off unit lane has no DB, so PG_INTEGRATION is
// unset there and the whole block skips.
const PG = process.env.PG_INTEGRATION === "1";

const TABLES = "paper_journal_entry, paper_command_receipt, paper_system_key, paper_account_owner, paper_journal_fence";

describe.skipIf(!PG)("PgPaperJournalStore (real postgres)", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  // Same contract as the in-memory oracle; TRUNCATE gives each case a clean slate.
  paperJournalContract("pg", async () => {
    await pool.query(`TRUNCATE ${TABLES}`);
    return new PgPaperJournalStore(pool);
  });

  it("closes the fence-first TOCTOU: an append racing an erase never survives below the fence", async () => {
    const store = new PgPaperJournalStore(pool);
    for (let i = 0; i < 25; i++) {
      await pool.query(`TRUNCATE ${TABLES}`);
      const entry = {
        entryReference: `paper-entry:acct-race:${i}`,
        account: "acct-race",
        revision: 1,
        recordedAt: new Date(0).toISOString(),
        kind: "account_opened",
        seedCash: [{ amount: 1, currency: "USD" }],
      };
      // race a low-epoch append against an erase to a higher fence, both orders.
      await Promise.all([
        store.appendSystem({ workspace: "ws-race", entry: entry as never, atEpoch: 1, scopedKey: `genesis:${i}` }),
        store.eraseWorkspace("ws-race", 5),
      ]);
      // fence is now >= 5 and the append epoch (1) is below it → entry must be absent.
      const rows = await pool.query("SELECT COUNT(*)::int AS n FROM paper_journal_entry WHERE workspace = 'ws-race'");
      expect(rows.rows[0].n).toBe(0);
    }
  });

  it("one append is one transaction: a mid-append crash never splits entry from receipt", async () => {
    await pool.query(`TRUNCATE ${TABLES}`);
    const store = new PgPaperJournalStore(pool);
    const entry = {
      entryReference: "paper-entry:acct-atomic:1",
      account: "acct-atomic",
      revision: 1,
      recordedAt: new Date(0).toISOString(),
      kind: "account_opened",
      seedCash: [{ amount: 1, currency: "USD" }],
    };
    await store.appendCommand({
      workspace: "ws-atomic", entry: entry as never, atEpoch: 1,
      receiptKey: "ws-atomic|paper-internal|acct-atomic|open|k1", canonicalPayload: "{}",
      outcome: { status: "applied", revision: 1, order: "paper-order:acct-atomic:1" } as never,
    });
    // duplicate entry_reference violates the PK → the whole tx rolls back, receipt included.
    await expect(store.appendCommand({
      workspace: "ws-atomic", entry: entry as never, atEpoch: 1,
      receiptKey: "ws-atomic|paper-internal|acct-atomic|open|k2", canonicalPayload: "{}",
      outcome: { status: "applied", revision: 1, order: "paper-order:acct-atomic:1" } as never,
    })).rejects.toThrow();
    const receipts = await pool.query("SELECT COUNT(*)::int AS n FROM paper_command_receipt WHERE workspace = 'ws-atomic'");
    expect(receipts.rows[0].n).toBe(1);
  });

  // Stage 2-c item 4 — the codex-unadjudicated question: when two PROCESSES retry
  // the same idempotency key at once (two journals over one durable store), does
  // the loser get the ORIGINAL receipt (§8) or a spurious conflict? The store maps
  // the receipt ON CONFLICT to a duplicate; this proves the journal cache layer
  // reconciles that to the original applied outcome, and money reserves exactly once.
  it("concurrent same-key retries across two journals: the loser replays the ORIGINAL receipt, money reserves once", async () => {
    const WS = "ws-race-key";
    const acct = brandReference<string, "InternalPaperAccountReference">("acct-race-key");
    const now = () => new Date(0).toISOString();
    for (let i = 0; i < 20; i++) {
      await pool.query(`TRUNCATE ${TABLES}`);
      // One store per journal — two independent processes racing one command.
      const j1 = await new PaperJournal(now, undefined, new PgPaperJournalStore(pool)).init();
      await j1.provision(WS, acct, [{ amount: 10_000, currency: "USD" }]);
      const j2 = await new PaperJournal(now, undefined, new PgPaperJournalStore(pool)).init();

      const revision = j1.currentRevision(WS, acct);
      const order = brandReference<string, "PaperOrderReference">(`paper-order:${String(acct)}:${revision + 1}`);
      const payload = limitBuy(10, 100);
      const control = { idempotencyKey: `race-${i}`, expectedRevision: String(revision) };
      const canonical = JSON.stringify({ key: `race-${i}`, quantity: 10, price: 100 });

      const [a, b] = await Promise.all([
        j1.appendCommand(WS, acct, "submit", control, canonical, decideBuy(payload, order) as never),
        j2.appendCommand(WS, acct, "submit", control, canonical, decideBuy(payload, order) as never),
      ]);

      // §8: same key + same payload → both observe the ORIGINAL applied outcome,
      // never a conflict. The two are byte-identical.
      expect(a.status).toBe("applied");
      expect(b.status).toBe("applied");
      expect(a).toEqual(b);

      // Money moved once: exactly one submit entry, reservation counted once.
      const entries = await pool.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM paper_journal_entry WHERE account = $1 AND (entry->>'kind') = 'order_submitted'",
        [String(acct)],
      );
      expect(entries.rows[0]?.n).toBe(1);
      const rehydrated = await new PaperJournal(now, undefined, new PgPaperJournalStore(pool)).init();
      expect(rehydrated.state(WS, acct).cash.get("USD")?.reserved).toBe(toMinorUnits({ amount: 1_000, currency: "USD" }));
    }
  });
});
