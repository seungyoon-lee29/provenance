import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Pool } from "pg";

import type { EntropySource, IdentityClock } from "../src/modules/identity/contracts";
import { PgIdentityStore } from "../src/modules/identity/session-store.pg";
import { PgPersonalCache } from "../src/modules/financial-information/data/personal-cache.pg";
import { brandReference } from "../src/shared/contracts/brands";
import type { InternalPaperAccountReference } from "../src/shared/contracts/brands";
import { PaperJournal } from "../src/modules/paper-trading/internal/journal";
import { PgPaperJournalStore } from "../src/modules/paper-trading/internal/journal-store.pg";
import type { PaperOrderPayload } from "../src/modules/paper-trading/internal/contracts";

/**
 * SEC-09 gate-2 stack proof (ticket 23 slice 3b-iv). Two backup/restore drills against REAL postgres
 * via pg_dump/psql roundtrips — the F11 gate-2 property that could not hold on the in-memory tracer:
 *
 *   1. post-erase roundtrip: seed → erase → pg_dump → restore into a clean db → migrate →
 *      the erased account + every workspace's cache is ABSENT, the deletion fence row is PRESENT,
 *      and re-auth returns the closed tombstone (recreation suppressed).
 *   2. stale-backup restore (FATAL defense): a backup taken BEFORE the erase, restored over the live
 *      db, must NOT resurrect deleted data. The fence is forward-only: the restore procedure re-merges
 *      the live deletion high-water (GREATEST) that the stale snapshot lacks, so the erased account
 *      stays fenced and every restored session/cache entry stays suppressed.
 *
 * The forward-only fence merge is the documented restore procedure this drill exercises and asserts —
 * a naive `psql < stale_dump` alone would drop the fence and resurrect the data, which the drill proves
 * is closed by the merge step.
 *
 * Scope honesty (ticket 23 slice 3b-viii): this proves the restore PROCEDURE holds for the migrated
 * stores (Identity + PersonalCache). It re-injects a high-water captured in this script's own memory
 * rather than from a shipped, operator-driven deletion ledger — so it demonstrates gate-2's property,
 * not an end-to-end operator restore. An independent deletion ledger + restore tooling is P2.
 */

const exec = promisify(execFile);

// Real (not deterministic) clock/entropy — the drill needs live-ish unique refs, and expiry is not
// under test here (the contract suite covers injected-clock expiry).
const clock: IdentityClock = { now: () => Date.now() };
const entropy: EntropySource = { token: (length: number) => randomBytes(length).toString("hex") };

function urlWithDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function pgDump(databaseUrl: string, outFile: string): Promise<void> {
  await exec("pg_dump", ["--clean", "--if-exists", "--no-owner", "--no-privileges", "-f", outFile, "-d", databaseUrl]);
}

async function psqlFile(databaseUrl: string, inFile: string): Promise<void> {
  await exec("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-f", inFile, "-d", databaseUrl]);
}

async function psqlExec(databaseUrl: string, sql: string): Promise<void> {
  await exec("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-c", sql, "-d", databaseUrl]);
}

const ALL_TABLES =
  "identity_receipt, identity_session, identity_account_fence, identity_account_workspace, identity_account, personal_cache_entry, personal_cache_fence, "
  + "paper_journal_entry, paper_command_receipt, paper_system_key, paper_account_owner, paper_journal_fence";

/** Seed the paper money ledger: genesis + one reserving limit-buy order — enough rows in every paper table. */
async function seedPaperLedger(pool: Pool, workspace: string): Promise<InternalPaperAccountReference> {
  const journal = await new PaperJournal(() => new Date().toISOString(), undefined, new PgPaperJournalStore(pool)).init();
  const account = brandReference<string, "InternalPaperAccountReference">(`paper-account:drill:${workspace}`);
  await journal.provision(workspace, account, [{ amount: 1_000_000, currency: "USD" }]);
  const order = brandReference<string, "PaperOrderReference">(`paper-order:${String(account)}:2`);
  const payload = {
    instrument: brandReference<string, "PaperInstrumentReference">("instr:DRILL"),
    venue: "NASDAQ", session: "regular", side: "buy", orderType: "limit",
    limitPrice: { amount: 100, currency: "USD" }, quantity: 10, timeInForce: "GTC",
  } as PaperOrderPayload;
  const outcome = await journal.appendCommand(
    workspace, account, "submit", { idempotencyKey: "drill-submit", expectedRevision: "1" }, "drill",
    () => ({ entry: { kind: "order_submitted", order, payload, acceptedAt: new Date().toISOString(), reservation: { kind: "cash", unitPrice: payload.limitPrice! } }, order }),
  );
  assert.equal(outcome.status, "applied", "seed: paper submit lands");
  return account;
}

/** Hydrate a fresh journal over the pool — what a server restart observes. */
async function hydratePaper(pool: Pool): Promise<PaperJournal> {
  return await new PaperJournal(() => new Date().toISOString(), undefined, new PgPaperJournalStore(pool)).init();
}

async function resetPrimary(databaseUrl: string): Promise<void> {
  await psqlExec(databaseUrl, `TRUNCATE ${ALL_TABLES} CASCADE`);
  await psqlExec(databaseUrl, "ALTER SEQUENCE identity_fence_seq RESTART WITH 1");
}

/** The deletion high-water a forward-only restore must preserve across a stale-backup restore. */
type FenceHighWater = Readonly<{
  identity: ReadonlyArray<{ account: string; fence: number }>;
  cache: ReadonlyArray<{ workspace: string; fence: number }>;
  paper: ReadonlyArray<{ workspace: string; fence: number }>;
  seq: number;
}>;

async function captureFenceHighWater(pool: Pool): Promise<FenceHighWater> {
  const identity = (await pool.query<{ account_reference: string; fence: string }>("SELECT account_reference, fence FROM identity_account_fence")).rows;
  const cache = (await pool.query<{ workspace: string; fence: string }>("SELECT workspace, fence FROM personal_cache_fence")).rows;
  const paper = (await pool.query<{ workspace: string; fence: string }>("SELECT workspace, fence FROM paper_journal_fence")).rows;
  const seq = Number((await pool.query<{ v: string }>("SELECT last_value AS v FROM identity_fence_seq")).rows[0]!.v);
  return {
    identity: identity.map((r) => ({ account: r.account_reference, fence: Number(r.fence) })),
    cache: cache.map((r) => ({ workspace: r.workspace, fence: Number(r.fence) })),
    paper: paper.map((r) => ({ workspace: r.workspace, fence: Number(r.fence) })),
    seq,
  };
}

/** Forward-only fence restore: re-apply the captured deletion high-water the stale snapshot lacks. */
async function mergeFenceForward(pool: Pool, highWater: FenceHighWater): Promise<void> {
  for (const f of highWater.identity) {
    await pool.query(
      `INSERT INTO identity_account_fence (account_reference, fence) VALUES ($1, $2)
       ON CONFLICT (account_reference) DO UPDATE SET fence = GREATEST(identity_account_fence.fence, EXCLUDED.fence)`,
      [f.account, f.fence],
    );
  }
  for (const f of highWater.cache) {
    await pool.query(
      `INSERT INTO personal_cache_fence (workspace, fence) VALUES ($1, $2)
       ON CONFLICT (workspace) DO UPDATE SET fence = GREATEST(personal_cache_fence.fence, EXCLUDED.fence)`,
      [f.workspace, f.fence],
    );
  }
  for (const f of highWater.paper) {
    await pool.query(
      `INSERT INTO paper_journal_fence (workspace, fence) VALUES ($1, $2)
       ON CONFLICT (workspace) DO UPDATE SET fence = GREATEST(paper_journal_fence.fence, EXCLUDED.fence)`,
      [f.workspace, f.fence],
    );
  }
  // The sequence itself is deletion state: never let a restore rewind it below the live high-water.
  await pool.query("SELECT setval('identity_fence_seq', GREATEST((SELECT last_value FROM identity_fence_seq), $1))", [highWater.seq]);
}

async function scenarioPostEraseRoundtrip(primaryUrl: string, adminUrl: string, dumpDir: string): Promise<void> {
  await resetPrimary(primaryUrl);
  const pool = new Pool({ connectionString: primaryUrl });
  const identity = new PgIdentityStore(pool, clock, entropy);
  const cache = new PgPersonalCache(pool);

  // Seed: an email account owning TWO workspaces, a live session, and cache entries in each workspace.
  const email = "erased@example.com";
  const account = await identity.ensureEmailAccount(email);
  const ws1 = await identity.primaryWorkspace(account);
  const ws2 = `workspace:${entropy.token(16)}`;
  await identity.addWorkspace(account.accountReference, ws2);
  const session = await identity.issueSession(account.accountReference, ws1);
  await cache.write(ws1, "quote", "AAPL", 1);
  await cache.write(ws2, "quote", "MSFT", 1);
  const paperAccount = await seedPaperLedger(pool, ws1);
  assert.equal((await identity.resolve(session.proof)).kind, "workspace", "seed: session resolves before erase");

  // Erase (account scope): fence + shred sessions, then cascade the cache AND
  // paper-ledger fences to EVERY workspace (T2-b: the money ledger is durable
  // PII surface now — the same one-fence procedure must cover it).
  const fence = await identity.erase(account.accountReference);
  for (const ws of await identity.workspacesOf(account.accountReference)) {
    await cache.eraseWorkspace(ws, fence + 1);
    await (await hydratePaper(pool)).eraseWorkspace(ws, fence + 1);
  }

  // Backup AFTER erase, restore into a pristine database, then migrate (must be a no-op reconcile).
  const dumpFile = path.join(dumpDir, "post-erase.sql");
  await pgDump(primaryUrl, dumpFile);
  await psqlExec(adminUrl, "DROP DATABASE IF EXISTS provenance_restore");
  await psqlExec(adminUrl, "CREATE DATABASE provenance_restore");
  const restoreUrl = urlWithDatabase(primaryUrl, "provenance_restore");
  await psqlFile(restoreUrl, dumpFile);
  await exec("npm", ["run", "db:migrate"], { env: { ...process.env, DATABASE_URL: restoreUrl } });

  const restorePool = new Pool({ connectionString: restoreUrl });
  try {
    const rIdentity = new PgIdentityStore(restorePool, clock, entropy);
    const rCache = new PgPersonalCache(restorePool);
    assert.equal(await rIdentity.isErasedAccount(account.accountReference), true, "restore: deletion fence row present");
    assert.equal(await rIdentity.fenceFor(account.accountReference), fence, "restore: fence value preserved");
    assert.equal((await rIdentity.resolve(session.proof)).kind, "guest", "restore: shredded session stays dead");
    const reauth = await rIdentity.ensureEmailAccount(email);
    assert.equal(reauth.accountReference, account.accountReference, "restore: re-auth returns the same account, not a fresh one");
    assert.equal(reauth.state, "closed", "restore: recreation suppressed — account stays a closed tombstone");
    assert.equal(await rCache.size(ws1), 0, "restore: ws1 cache absent");
    assert.equal(await rCache.size(ws2), 0, "restore: ws2 cache absent (all workspaces cascaded)");
    const rPaper = await hydratePaper(restorePool);
    assert.equal(rPaper.list(ws1, paperAccount).length, 0, "restore: paper ledger absent");
    assert.equal(rPaper.ownerOf(paperAccount), undefined, "restore: paper ownership absent");
    const paperFence = await restorePool.query<{ fence: string }>("SELECT fence FROM paper_journal_fence WHERE workspace = $1", [ws1]);
    assert.equal(Number(paperFence.rows[0]?.fence), fence + 1, "restore: paper deletion fence row present");
    // recreation suppressed: a pre-erasure epoch (1) cannot re-open the account.
    await rPaper.provision(ws1, paperAccount, [{ amount: 1, currency: "USD" }]);
    assert.equal(rPaper.ownerOf(paperAccount), undefined, "restore: paper recreation suppressed behind the fence");
  } finally {
    await restorePool.end();
  }
  await pool.end();
  await psqlExec(adminUrl, "DROP DATABASE IF EXISTS provenance_restore");
  console.log("drill 1 (post-erase roundtrip) passed");
}

async function scenarioStaleBackupRestore(primaryUrl: string, dumpDir: string): Promise<void> {
  await resetPrimary(primaryUrl);
  const pool = new Pool({ connectionString: primaryUrl });
  const identity = new PgIdentityStore(pool, clock, entropy);
  const cache = new PgPersonalCache(pool);

  // Seed an ACTIVE account + live session + cache entry, then snapshot it (this backup predates the erase).
  const email = "stale@example.com";
  const account = await identity.ensureEmailAccount(email);
  const ws = await identity.primaryWorkspace(account);
  const session = await identity.issueSession(account.accountReference, ws);
  await cache.write(ws, "quote", "NVDA", 1);
  const paperAccount = await seedPaperLedger(pool, ws);
  const staleDump = path.join(dumpDir, "stale-pre-erase.sql");
  await pgDump(primaryUrl, staleDump);

  // Erase happens AFTER the snapshot — the stale backup has no knowledge of it.
  const fence = await identity.erase(account.accountReference);
  await cache.eraseWorkspace(ws, fence + 1);
  await (await hydratePaper(pool)).eraseWorkspace(ws, fence + 1);
  const highWater = await captureFenceHighWater(pool);

  // Naive restore of the stale snapshot resurrects the account row + session + cache entry + the
  // paper money ledger (pg_dump --clean dropped the fence tables and recreated them from the
  // pre-erase state) …
  await psqlFile(primaryUrl, staleDump);
  assert.equal(await identity.isErasedAccount(account.accountReference), false, "precondition: naive restore alone drops the fence");
  const resurrected = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM paper_journal_entry WHERE workspace = $1", [ws]);
  assert.ok(resurrected.rows[0]!.n > 0, "precondition: naive restore resurrects paper ledger rows");
  // … so the restore procedure re-merges the forward-only deletion high-water the snapshot lacked.
  await mergeFenceForward(pool, highWater);

  // Deletion now dominates the stale restore: nothing the backup carried is observable.
  assert.equal(await identity.isErasedAccount(account.accountReference), true, "stale restore: fence dominates (account still erased)");
  assert.equal((await identity.resolve(session.proof)).kind, "guest", "stale restore: resurrected session stays dead behind the fence");
  assert.equal(await cache.isErased(ws, 1), true, "stale restore: resurrected cache entry stays suppressed");
  // Paper rows carry their write epoch (≤ fence), so hydration re-judges and suppresses every one.
  const stalePaper = await hydratePaper(pool);
  assert.equal(stalePaper.list(ws, paperAccount).length, 0, "stale restore: resurrected paper entries stay suppressed behind the fence");
  assert.equal(stalePaper.ownerOf(paperAccount), undefined, "stale restore: resurrected paper ownership stays suppressed");
  // A fresh erase must still advance beyond the restored high-water (sequence was not rewound).
  const fresh = await identity.ensureEmailAccount("post-restore@example.com");
  const nextFence = await identity.erase(fresh.accountReference);
  assert.ok(nextFence > fence, "stale restore: fence sequence not rewound — new erasures still advance");

  await pool.end();
  console.log("drill 2 (stale-backup restore dominance) passed");
}

async function main(): Promise<void> {
  const primaryUrl = process.env.DATABASE_URL;
  if (primaryUrl === undefined) throw new Error("DATABASE_URL is required for the backup drill");
  const adminUrl = urlWithDatabase(primaryUrl, "postgres");
  const dumpDir = await mkdtemp(path.join(tmpdir(), "backup-drill-"));
  try {
    await scenarioPostEraseRoundtrip(primaryUrl, adminUrl, dumpDir);
    await scenarioStaleBackupRestore(primaryUrl, dumpDir);
    console.log("backup drill passed (SEC-09 gate-2)");
  } finally {
    await rm(dumpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
