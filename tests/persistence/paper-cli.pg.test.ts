import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { paperAccountCommand, paperOpenCommand } from "../../src/cli/commands";

// T8 S2 — the durable CLI paper surface against REAL postgres: the production
// composition (createDurablePaperTrading → PgPaperJournalStore) provisions a
// genesis exactly once and reads it back. Runs only in the compose
// persistence-integration profile, like the other pg-lane suites.
const PG = process.env.PG_INTEGRATION === "1";

const TABLES = "paper_journal_entry, paper_command_receipt, paper_system_key, paper_account_owner, paper_journal_fence";

describe.skipIf(!PG)("T8 S2 CLI paper commands (real postgres)", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`TRUNCATE ${TABLES}`);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("account before genesis reads exists:false without creating anything", async () => {
    const { envelope, exitCode } = await paperAccountCommand({ pool });
    expect(exitCode).toBe(0);
    if (!envelope.ok) throw new Error(envelope.error.message);
    expect(envelope.result).toMatchObject({ exists: false });
    const rows = await pool.query("SELECT COUNT(*)::int AS count FROM paper_journal_entry");
    expect(rows.rows[0]!.count).toBe(0);
  });

  it("open provisions genesis once; a re-open keeps the ORIGINAL ledger (created:false)", async () => {
    const first = await paperOpenCommand({ seed: 1_000_000, currency: "KRW" }, { pool });
    if (!first.envelope.ok) throw new Error(first.envelope.error.message);
    expect(first.envelope.result).toMatchObject({ created: true, cash: [{ currency: "KRW", balance: 1_000_000 }] });

    // A different seed on re-open must NOT re-seed — genesis is once.
    const second = await paperOpenCommand({ seed: 555, currency: "KRW" }, { pool });
    if (!second.envelope.ok) throw new Error(second.envelope.error.message);
    expect(second.envelope.result).toMatchObject({ created: false, cash: [{ currency: "KRW", balance: 1_000_000 }] });

    // A fresh process (new assembly, same database) reads the durable state.
    const read = await paperAccountCommand({ pool });
    if (!read.envelope.ok) throw new Error(read.envelope.error.message);
    expect(read.envelope.result).toMatchObject({ exists: true, cash: [{ currency: "KRW", balance: 1_000_000 }] });
  });
});
