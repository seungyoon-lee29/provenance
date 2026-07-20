import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgPersonalCache } from "../../src/modules/financial-information/data/personal-cache.pg";
import { PgIdentityStore } from "../../src/modules/identity/session-store.pg";
import { IdentityTestClock, SequenceEntropy } from "../harness/identity-harness";

// Runs only in the compose persistence-integration profile (real postgres + migrated schema). The
// network-off unit lane has no DB, so PG_INTEGRATION is unset there and the whole block skips.
const PG = process.env.PG_INTEGRATION === "1";

async function reset(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE identity_receipt, identity_session, identity_account_fence, identity_account_workspace, identity_account CASCADE");
  await pool.query("ALTER SEQUENCE identity_fence_seq RESTART WITH 1");
  await pool.query("TRUNCATE personal_cache_entry, personal_cache_fence");
}

// Ticket 23 slice 3b-vi: the SEC-09 physical-residue gap (F7) is closed by folding the identity
// deletion fence AND the participant cache shred into ONE pg transaction, not a recovery journal.
// A crash mid-erase must leave ZERO durable partial state — either the whole erase committed
// (no residue) or none of it did (retryable, nothing suppressed yet).
describe.skipIf(!PG)("erase atomicity (identity fence + personal cache in one UnitOfWork)", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("a fault after both writes rolls back the identity fence AND the cache shred — zero partial state", async () => {
    await reset(pool);
    const clock = new IdentityTestClock(1_000_000);
    const idStore = new PgIdentityStore(pool, clock, new SequenceEntropy("atomic"));
    const cache = new PgPersonalCache(pool);
    const account = await idStore.ensureEmailAccount("atomic@example.com");
    const ws = await idStore.primaryWorkspace(account);
    await cache.write(ws, "secret", "pii", 1); // seed personal data above the fence

    await expect(
      idStore.withUnitOfWork(async (tx) => {
        const fence = await idStore.erase(account.accountReference, tx);
        await cache.eraseWorkspace(ws, fence, tx);
        throw new Error("crash after both writes, before commit");
      }),
    ).rejects.toThrow(/crash after both writes/);

    // Nothing committed: fence not raised, account still active, personal data still present.
    expect(await idStore.isErasedAccount(account.accountReference)).toBe(false);
    expect(await idStore.accountState(account.accountReference)).toBe("active");
    expect(await cache.read(ws, "secret")).toBe("pii");
    expect(await cache.fenceOf(ws)).toBe(0);
  });

  it("a committed UnitOfWork raises the identity fence AND shreds the cache together — no residue", async () => {
    await reset(pool);
    const clock = new IdentityTestClock(1_000_000);
    const idStore = new PgIdentityStore(pool, clock, new SequenceEntropy("commit"));
    const cache = new PgPersonalCache(pool);
    const account = await idStore.ensureEmailAccount("commit@example.com");
    const ws = await idStore.primaryWorkspace(account);
    await cache.write(ws, "secret", "pii", 1);

    await idStore.withUnitOfWork(async (tx) => {
      const fence = await idStore.erase(account.accountReference, tx);
      await cache.eraseWorkspace(ws, fence, tx);
    });

    expect(await idStore.isErasedAccount(account.accountReference)).toBe(true);
    expect(await cache.read(ws, "secret")).toBeUndefined();
    expect(await cache.size(ws)).toBe(0);
  });
});
