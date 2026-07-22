import type { Pool, PoolClient } from "pg";

import { withExecutor, withTransaction, type Executor } from "../../../platform/persistence/pg";
import type {
  PaperCommandAppend,
  PaperEraseOutcome,
  PaperJournalSnapshot,
  PaperJournalStore,
  PaperStoreAppendOutcome,
  PaperSystemAppend,
} from "./journal";
import type { PaperJournalEntry } from "./journal";
import type { PaperCommandOutcome } from "./contracts";

/**
 * PostgreSQL implementation of PaperJournalStore (Stage 2 T2-b). Passes the
 * SAME contract suite as the in-memory store. The invariants that need SQL
 * care mirror PgPersonalCache:
 *
 * - fence-first is a TOCTOU without a lock: every append and the erase take
 *   `SELECT … FOR UPDATE` on the workspace fence row BEFORE touching rows, so
 *   an append racing an erase serializes on that row and can never land an
 *   entry below the committed fence.
 * - the fence is monotonic (GREATEST), and one append is ONE transaction:
 *   entry + receipt (command) or entry + system key + owner (system) commit or
 *   roll back together — a crash never splits a money movement from its
 *   idempotency record.
 */
export class PgPaperJournalStore implements PaperJournalStore {
  constructor(private readonly pool: Pool) {}

  async #lockFence(client: PoolClient, workspace: string): Promise<number> {
    await client.query("INSERT INTO paper_journal_fence (workspace, fence) VALUES ($1, 0) ON CONFLICT (workspace) DO NOTHING", [workspace]);
    const locked = await client.query<{ fence: string }>("SELECT fence FROM paper_journal_fence WHERE workspace = $1 FOR UPDATE", [workspace]);
    return locked.rows[0] ? Number(locked.rows[0].fence) : 0;
  }

  appendCommand(append: PaperCommandAppend): Promise<PaperStoreAppendOutcome> {
    return withTransaction(this.pool, async (client) => {
      const fence = await this.#lockFence(client, append.workspace);
      if (append.atEpoch <= fence) return { status: "suppressed" };
      // Receipt FIRST: a durable receipt this cache never saw means the store
      // already applied this command (a lost COMMIT ack, or a writer the cache
      // does not know). Report it as a duplicate so the journal rehydrates
      // instead of raising a raw constraint error (codex T2-b finding).
      const receipted = await client.query(
        "INSERT INTO paper_command_receipt (workspace, receipt_key, canonical_payload, at_epoch, outcome) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
        [append.workspace, append.receiptKey, append.canonicalPayload, append.atEpoch, JSON.stringify(append.outcome)],
      );
      if ((receipted.rowCount ?? 0) === 0) return { status: "duplicate" };
      // The revision UNIQUE stays a hard error on purpose: a collision here
      // means a second writer folded the same revision, which this design does
      // not support — loud beats a silently overwritten money entry.
      await client.query(
        "INSERT INTO paper_journal_entry (workspace, entry_reference, account, revision, at_epoch, entry) VALUES ($1, $2, $3, $4, $5, $6)",
        [append.workspace, String(append.entry.entryReference), String(append.entry.account), append.entry.revision, append.atEpoch, JSON.stringify(append.entry)],
      );
      return { status: "applied" };
    });
  }

  appendSystem(append: PaperSystemAppend): Promise<PaperStoreAppendOutcome> {
    return withTransaction(this.pool, async (client) => {
      const fence = await this.#lockFence(client, append.workspace);
      if (append.atEpoch <= fence) return { status: "suppressed" };
      // Owner adjudication FIRST: a genesis for an account already owned by a
      // DIFFERENT workspace must not seed money twice (codex T2-b finding).
      // The PK insert serializes concurrent racers; the loser reads the
      // committed winner and conflicts.
      if (append.owner !== undefined) {
        const claimed = await client.query(
          "INSERT INTO paper_account_owner (account, workspace, at_epoch) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [String(append.entry.account), append.owner, append.atEpoch],
        );
        if ((claimed.rowCount ?? 0) === 0) {
          const existing = await client.query<{ workspace: string }>("SELECT workspace FROM paper_account_owner WHERE account = $1", [String(append.entry.account)]);
          if (existing.rows[0]?.workspace !== append.owner) return { status: "conflict" };
        }
      }
      const inserted = await client.query(
        "INSERT INTO paper_system_key (workspace, scoped_key, at_epoch) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [append.workspace, append.scopedKey, append.atEpoch],
      );
      // ROLLBACK on the duplicate path would also be fine; nothing else was
      // written for this workspace-scoped key, and the owner claim (if any)
      // belongs to the same logical genesis, so committing it is idempotent.
      if ((inserted.rowCount ?? 0) === 0) return { status: "duplicate" };
      await client.query(
        "INSERT INTO paper_journal_entry (workspace, entry_reference, account, revision, at_epoch, entry) VALUES ($1, $2, $3, $4, $5, $6)",
        [append.workspace, String(append.entry.entryReference), String(append.entry.account), append.entry.revision, append.atEpoch, JSON.stringify(append.entry)],
      );
      return { status: "applied" };
    });
  }

  eraseWorkspace(workspace: string, fence: number, tx?: Executor): Promise<PaperEraseOutcome> {
    return withExecutor(this.pool, tx, async (client) => {
      const current = await this.#lockFence(client, workspace);
      // A delayed lower erase is a no-op: it must not shred data legitimately
      // written at a higher post-erasure epoch (codex T2-b finding).
      if (fence <= current) return { status: "stale", shredded: 0 };
      const deleted = await client.query("DELETE FROM paper_journal_entry WHERE workspace = $1", [workspace]);
      await client.query("DELETE FROM paper_command_receipt WHERE workspace = $1", [workspace]);
      await client.query("DELETE FROM paper_system_key WHERE workspace = $1", [workspace]);
      await client.query("DELETE FROM paper_account_owner WHERE workspace = $1", [workspace]);
      await client.query("UPDATE paper_journal_fence SET fence = $2 WHERE workspace = $1", [workspace, fence]);
      return { status: "erased", shredded: deleted.rowCount ?? 0 };
    });
  }

  async load(): Promise<PaperJournalSnapshot> {
    // One REPEATABLE READ snapshot for all five tables: parallel single-shot
    // queries could each see a different commit horizon and hand hydration a
    // receipt without its entry (codex T2-b finding).
    const [entries, receipts, systemKeys, owners, fences] = await withTransaction(this.pool, async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return [
        await client.query<{ workspace: string; entry: PaperJournalEntry; at_epoch: string }>(
          "SELECT workspace, entry, at_epoch FROM paper_journal_entry ORDER BY workspace, account, revision",
        ),
        await client.query<{ workspace: string; receipt_key: string; canonical_payload: string; outcome: PaperCommandOutcome; at_epoch: string }>(
          "SELECT workspace, receipt_key, canonical_payload, outcome, at_epoch FROM paper_command_receipt",
        ),
        await client.query<{ workspace: string; scoped_key: string; at_epoch: string }>("SELECT workspace, scoped_key, at_epoch FROM paper_system_key"),
        await client.query<{ account: string; workspace: string; at_epoch: string }>("SELECT account, workspace, at_epoch FROM paper_account_owner"),
        await client.query<{ workspace: string; fence: string }>("SELECT workspace, fence FROM paper_journal_fence"),
      ] as const;
    });
    return {
      entries: entries.rows.map((row) => ({ workspace: row.workspace, entry: row.entry, atEpoch: Number(row.at_epoch) })),
      receipts: receipts.rows.map((row) => ({
        workspace: row.workspace,
        receiptKey: row.receipt_key,
        canonicalPayload: row.canonical_payload,
        outcome: row.outcome,
        atEpoch: Number(row.at_epoch),
      })),
      systemKeys: systemKeys.rows.map((row) => ({ workspace: row.workspace, scopedKey: row.scoped_key, atEpoch: Number(row.at_epoch) })),
      owners: owners.rows.map((row) => ({ account: row.account, workspace: row.workspace, atEpoch: Number(row.at_epoch) })),
      fences: fences.rows.map((row) => ({ workspace: row.workspace, fence: Number(row.fence) })),
    };
  }
}
