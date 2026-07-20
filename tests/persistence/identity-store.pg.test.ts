import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgIdentityStore } from "../../src/modules/identity/session-store.pg";
import { IdentityTestClock, SequenceEntropy } from "../harness/identity-harness";
import { identityStoreContract } from "./identity-store-contract";

// Runs only in the compose persistence-integration profile (real postgres + migrated schema). The
// network-off unit lane has no DB, so PG_INTEGRATION is unset there and the whole block skips.
const PG = process.env.PG_INTEGRATION === "1";

async function reset(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE identity_receipt, identity_session, identity_account_fence, identity_account_workspace, identity_account CASCADE");
  await pool.query("ALTER SEQUENCE identity_fence_seq RESTART WITH 1");
}

// Poll until a backend is parked on an ungranted lock — i.e. switchWorkspace is blocked on the
// account FOR UPDATE a holder connection owns. Makes the revoke-escape race deterministic instead of
// relying on scheduler luck (which could leave the dangerous interleaving unexercised).
async function waitForLockWaiter(pool: Pool): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted");
    if ((r.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("expected switchWorkspace to block on the account lock");
}

describe.skipIf(!PG)("PgIdentityStore (real postgres)", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  // Same contract as the in-memory oracle; a clean slate per case.
  identityStoreContract("pg", async (clock, entropy) => {
    await reset(pool);
    return new PgIdentityStore(pool, clock, entropy);
  });

  it("closes the fence-first TOCTOU: a session issued while an erase races never survives the erase", async () => {
    for (let i = 0; i < 25; i++) {
      await reset(pool);
      const store = new PgIdentityStore(pool, new IdentityTestClock(1_000_000), new SequenceEntropy(`race${i}`));
      const account = await store.ensureEmailAccount(`race${i}@example.com`);
      const ws = await store.primaryWorkspace(account);

      const [issue] = await Promise.allSettled([
        store.issueSession(account.accountReference, ws),
        store.erase(account.accountReference),
      ]);

      expect(await store.isErasedAccount(account.accountReference)).toBe(true); // erase committed its fence
      // Whether the issue won the lock (then shredded) or lost it (then rejected), no session of an
      // erased account may ever resolve to a workspace viewer.
      if (issue.status === "fulfilled") {
        expect((await store.resolve(issue.value.proof)).kind).toBe("guest");
      }
    }
  });

  it("survives a process restart: a fresh store on the same pool sees the persisted session, then the fence", async () => {
    await reset(pool);
    const clock = new IdentityTestClock(1_000_000);
    const writer = new PgIdentityStore(pool, clock, new SequenceEntropy("writer"));
    const account = await writer.ensureEmailAccount("restart@example.com");
    const ws = await writer.primaryWorkspace(account);
    const issued = await writer.issueSession(account.accountReference, ws);

    // A brand-new store instance (proxy for a process restart) resolves the persisted session.
    const rebooted = new PgIdentityStore(pool, clock, new SequenceEntropy("rebooted"));
    expect((await rebooted.resolve(issued.proof)).kind).toBe("workspace");

    // An erase through one instance is durable and visible to another.
    await writer.erase(account.accountReference);
    const afterErase = new PgIdentityStore(pool, clock, new SequenceEntropy("after"));
    expect((await afterErase.resolve(issued.proof)).kind).toBe("guest");
    expect(await afterErase.isErasedAccount(account.accountReference)).toBe(true);
  });

  it("closes the switchWorkspace revoke-escape: a revoke committed while a switch is parked wins", async () => {
    await reset(pool);
    const store = new PgIdentityStore(pool, new IdentityTestClock(1_000_000), new SequenceEntropy("escape"));
    const account = await store.ensureEmailAccount("escape@example.com");
    const ws1 = await store.primaryWorkspace(account);
    const ws2 = "workspace:escape-2";
    await store.addWorkspace(account.accountReference, ws2);
    const issued = await store.issueSession(account.accountReference, ws1);

    const holder = await pool.connect();
    let switchPromise: ReturnType<typeof store.switchWorkspace> = Promise.resolve(undefined);
    try {
      // Hold the account row lock so the switch parks AFTER its unlocked preview read but BEFORE the
      // locked session re-read — deterministically forcing the exact window the fix targets.
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM identity_account WHERE account_reference = $1 FOR UPDATE", [account.accountReference]);
      switchPromise = store.switchWorkspace(issued.proof, ws2);
      await waitForLockWaiter(pool); // the switch is now parked on the account lock, past its preview

      // Revoke commits while the switch is parked; releasing the lock lets the switch's locked re-read run.
      expect(await store.revokeCurrent(issued.proof)).toBe(true);
      await holder.query("COMMIT");
    } finally {
      holder.release();
    }

    // Reverting the FOR UPDATE re-read would rotate the stale revoked=false preview into a live session;
    // with it, the switch observes revoked=true under lock and refuses. No session escapes the revoke.
    expect(await switchPromise).toBeUndefined();
    expect((await store.resolve(issued.proof)).kind).toBe("guest");
  });

  it("a command receipt survives a process restart: a retry on a fresh store replays it (no re-execution)", async () => {
    await reset(pool);
    const writer = new PgIdentityStore(pool, new IdentityTestClock(1_000_000), new SequenceEntropy("rcpt-writer"));
    await writer.putReceipt("erase", "proof-hash-1", "idem-1", "payload-1", { kind: "ErasureCommandOutcome", status: "accepted", fence: "1" });

    // A fresh instance (proxy for a restart) finds the persisted receipt by its pre-resolve coordinates.
    const rebooted = new PgIdentityStore(pool, new IdentityTestClock(1_000_000), new SequenceEntropy("rcpt-reboot"));
    expect(await rebooted.getReceipt("erase", "proof-hash-1", "idem-1")).toEqual({
      payloadHash: "payload-1",
      outcome: { kind: "ErasureCommandOutcome", status: "accepted", fence: "1" },
    });
  });
});
