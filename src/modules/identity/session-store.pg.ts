import type { Pool, PoolClient } from "pg";

import type { AccountReference, WorkspaceReference } from "../../shared/contracts";
import type { GuestViewerContext, ViewerContext } from "../../shared/contracts/viewer-context";
import { withExecutor, withTransaction, type Executor } from "../../platform/persistence/pg";
import type { EntropySource, IdentityClock, SessionProof } from "./contracts";
import {
  ABSOLUTE_EXPIRY_MS,
  buildWorkspaceViewer,
  hashProof,
  sessionIsLive,
  type AccountRecord,
  type AccountState,
  type IdentityStore,
  type IssuedSession,
  type ReceiptKind,
  type StoredReceipt,
} from "./session-store";

type AccountRow = {
  account_reference: string;
  authorization_epoch: string;
  membership_revision: string;
  security_revision: string;
  state: string;
  email_key: string | null;
  identity_key: string | null;
  email_verified: boolean;
};

type SessionRow = {
  session_hash: string;
  session_reference: string;
  account_reference: string;
  workspace_reference: string;
  generation: string;
  epoch_at_issue: string;
  created_at_ms: string;
  last_seen_at_ms: string;
  absolute_expiry_ms: string;
  revoked: boolean;
};

function rowToAccount(row: AccountRow, workspaces: string[]): AccountRecord {
  return {
    accountReference: row.account_reference,
    authorizationEpoch: Number(row.authorization_epoch),
    membershipRevision: Number(row.membership_revision),
    securityRevision: Number(row.security_revision),
    state: row.state as AccountState,
    workspaces: new Set(workspaces),
    emailVerified: row.email_verified,
    ...(row.email_key ? { emailKey: row.email_key } : {}),
    ...(row.identity_key ? { identityKey: row.identity_key } : {}),
  };
}

/**
 * PostgreSQL implementation of IdentityStore (ticket 23 slice 3b-iii). Passes the SAME contract
 * suite as the in-memory store, and reuses the shared `sessionIsLive` / `buildWorkspaceViewer`
 * helpers so expiry + viewer semantics cannot diverge.
 *
 * fence-first is a TOCTOU without a lock: an `issueSession` racing an `erase` could read the account
 * as active, then insert a session after erase shredded the rest. Both `issueSession` and `erase`
 * (and `switchWorkspace`) take `SELECT … FOR UPDATE` on the account row before acting, so they
 * serialize on it — a session can never survive an erased account (design decision #1). The deletion
 * fence is monotonic (nextval + GREATEST) and never lowered by a restore.
 */
export class PgIdentityStore implements IdentityStore {
  constructor(
    private readonly pool: Pool,
    private readonly clock: IdentityClock,
    private readonly entropy: EntropySource,
  ) {}

  #guest(requestId: string): GuestViewerContext {
    return { kind: "guest", requestId };
  }

  async #workspacesOf(exec: Pool | PoolClient, accountReference: string): Promise<string[]> {
    const rows = await exec.query<{ workspace_reference: string }>(
      "SELECT workspace_reference FROM identity_account_workspace WHERE account_reference = $1",
      [accountReference],
    );
    return rows.rows.map((r) => r.workspace_reference);
  }

  async #createAccount(seed: { emailKey?: string; identityKey?: string; emailVerified: boolean }): Promise<AccountRecord> {
    const accountReference = `account:${this.entropy.token(16)}`;
    const workspaceReference = `workspace:${this.entropy.token(16)}`;
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO identity_account (account_reference, authorization_epoch, membership_revision, security_revision, state, email_key, identity_key, email_verified)
         VALUES ($1, 1, 1, 1, 'active', $2, $3, $4)`,
        [accountReference, seed.emailKey ?? null, seed.identityKey ?? null, seed.emailVerified],
      );
      await client.query("INSERT INTO identity_account_workspace (account_reference, workspace_reference) VALUES ($1, $2)", [accountReference, workspaceReference]);
    });
    return {
      accountReference,
      authorizationEpoch: 1,
      membershipRevision: 1,
      securityRevision: 1,
      state: "active",
      workspaces: new Set([workspaceReference]),
      emailVerified: seed.emailVerified,
      ...(seed.emailKey ? { emailKey: seed.emailKey } : {}),
      ...(seed.identityKey ? { identityKey: seed.identityKey } : {}),
    };
  }

  async ensureEmailAccount(email: string): Promise<AccountRecord> {
    return (await this.findEmailAccount(email)) ?? this.#createAccount({ emailKey: email.trim().toLowerCase(), emailVerified: true });
  }

  async createPendingEmailAccount(email: string): Promise<AccountRecord> {
    return this.#createAccount({ emailKey: email.trim().toLowerCase(), emailVerified: false });
  }

  async findEmailAccount(email: string): Promise<AccountRecord | undefined> {
    const row = (await this.pool.query<AccountRow>("SELECT * FROM identity_account WHERE email_key = $1", [email.trim().toLowerCase()])).rows[0];
    if (row === undefined) return undefined;
    return rowToAccount(row, await this.#workspacesOf(this.pool, row.account_reference));
  }

  async markEmailVerified(accountReference: string): Promise<void> {
    await this.pool.query("UPDATE identity_account SET email_verified = true WHERE account_reference = $1", [accountReference]);
  }

  async ensureFederatedAccount(identityKey: string): Promise<AccountRecord> {
    const row = (await this.pool.query<AccountRow>("SELECT * FROM identity_account WHERE identity_key = $1", [identityKey])).rows[0];
    if (row !== undefined) return rowToAccount(row, await this.#workspacesOf(this.pool, row.account_reference)); // erased account survives as a closed tombstone
    return this.#createAccount({ identityKey, emailVerified: true });
  }

  async primaryWorkspace(account: AccountRecord): Promise<string> {
    const first = [...account.workspaces][0];
    if (first === undefined) throw new Error("account has no workspace");
    return first;
  }

  async issueSession(accountReference: AccountReference | string, workspaceReference: WorkspaceReference | string): Promise<IssuedSession> {
    const accountRef = String(accountReference);
    const workspaceRef = String(workspaceReference);
    return withTransaction(this.pool, async (client) => {
      // Lock the account row first: serializes this issue with a concurrent erase (fence-first TOCTOU).
      const account = (await client.query<AccountRow>("SELECT * FROM identity_account WHERE account_reference = $1 FOR UPDATE", [accountRef])).rows[0];
      if (account === undefined) throw new Error("unknown account");
      const fenced = ((await client.query("SELECT 1 FROM identity_account_fence WHERE account_reference = $1", [accountRef])).rowCount ?? 0) > 0;
      if (account.state !== "active" || fenced) throw new Error("account cannot receive a session");
      const owns = ((await client.query("SELECT 1 FROM identity_account_workspace WHERE account_reference = $1 AND workspace_reference = $2", [accountRef, workspaceRef])).rowCount ?? 0) > 0;
      if (!owns) throw new Error("workspace not owned by account");
      const value = this.entropy.token(32);
      const now = this.clock.now();
      const sessionReference = `session:${this.entropy.token(16)}`;
      await client.query(
        `INSERT INTO identity_session (session_hash, session_reference, account_reference, workspace_reference, generation, epoch_at_issue, created_at_ms, last_seen_at_ms, absolute_expiry_ms, revoked)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $6, $7, false)`,
        [hashProof(value), sessionReference, accountRef, workspaceRef, Number(account.authorization_epoch), now, now + ABSOLUTE_EXPIRY_MS],
      );
      const requestId = this.entropy.token(8);
      return {
        proof: { kind: "SessionProof", value },
        viewer: buildWorkspaceViewer({
          workspaceReference: workspaceRef,
          accountReference: accountRef,
          sessionReference,
          generation: 1,
          authorizationEpoch: Number(account.authorization_epoch),
          membershipRevision: Number(account.membership_revision),
          requestId,
        }),
      };
    });
  }

  async resolve(proof: SessionProof): Promise<ViewerContext> {
    const requestId = this.entropy.token(8);
    const sessionHash = hashProof(proof.value);
    const session = (await this.pool.query<SessionRow>("SELECT * FROM identity_session WHERE session_hash = $1", [sessionHash])).rows[0];
    if (session === undefined) return this.#guest(requestId);
    const account = (await this.pool.query<AccountRow>("SELECT * FROM identity_account WHERE account_reference = $1", [session.account_reference])).rows[0];
    const fenced = ((await this.pool.query("SELECT 1 FROM identity_account_fence WHERE account_reference = $1", [session.account_reference])).rowCount ?? 0) > 0;
    const now = this.clock.now();
    const live = sessionIsLive({
      revoked: session.revoked,
      epochAtIssue: Number(session.epoch_at_issue),
      absoluteExpiryMs: Number(session.absolute_expiry_ms),
      lastSeenAtMs: Number(session.last_seen_at_ms),
      accountState: account?.state as AccountState | undefined,
      accountAuthorizationEpoch: account ? Number(account.authorization_epoch) : undefined,
      isFenced: fenced,
      nowMs: now,
    });
    if (!live || account === undefined) return this.#guest(requestId);
    await this.pool.query("UPDATE identity_session SET last_seen_at_ms = $2 WHERE session_hash = $1", [sessionHash, now]);
    return buildWorkspaceViewer({
      workspaceReference: session.workspace_reference,
      accountReference: account.account_reference,
      sessionReference: session.session_reference,
      generation: Number(session.generation),
      authorizationEpoch: Number(account.authorization_epoch),
      membershipRevision: Number(account.membership_revision),
      requestId,
    });
  }

  async revokeCurrent(proof: SessionProof): Promise<boolean> {
    const r = await this.pool.query("UPDATE identity_session SET revoked = true WHERE session_hash = $1 AND revoked = false", [hashProof(proof.value)]);
    return (r.rowCount ?? 0) > 0;
  }

  async revokeAll(accountReference: string): Promise<void> {
    await this.pool.query(
      "UPDATE identity_account SET authorization_epoch = authorization_epoch + 1, security_revision = security_revision + 1 WHERE account_reference = $1",
      [accountReference],
    );
  }

  async switchWorkspace(proof: SessionProof, workspaceReference: string): Promise<IssuedSession | undefined> {
    const sessionHash = hashProof(proof.value);
    return withTransaction(this.pool, async (client) => {
      const session = (await client.query<SessionRow>("SELECT * FROM identity_session WHERE session_hash = $1", [sessionHash])).rows[0];
      if (session === undefined) return undefined;
      const account = (await client.query<AccountRow>("SELECT * FROM identity_account WHERE account_reference = $1 FOR UPDATE", [session.account_reference])).rows[0];
      const fenced = ((await client.query("SELECT 1 FROM identity_account_fence WHERE account_reference = $1", [session.account_reference])).rowCount ?? 0) > 0;
      const live = sessionIsLive({
        revoked: session.revoked,
        epochAtIssue: Number(session.epoch_at_issue),
        absoluteExpiryMs: Number(session.absolute_expiry_ms),
        lastSeenAtMs: Number(session.last_seen_at_ms),
        accountState: account?.state as AccountState | undefined,
        accountAuthorizationEpoch: account ? Number(account.authorization_epoch) : undefined,
        isFenced: fenced,
        nowMs: this.clock.now(),
      });
      if (!live || account === undefined) return undefined;
      const owns = ((await client.query("SELECT 1 FROM identity_account_workspace WHERE account_reference = $1 AND workspace_reference = $2", [session.account_reference, workspaceReference])).rowCount ?? 0) > 0;
      if (!owns) return undefined;
      const value = this.entropy.token(32);
      const generation = Number(session.generation) + 1;
      await client.query("DELETE FROM identity_session WHERE session_hash = $1", [sessionHash]);
      await client.query(
        `INSERT INTO identity_session (session_hash, session_reference, account_reference, workspace_reference, generation, epoch_at_issue, created_at_ms, last_seen_at_ms, absolute_expiry_ms, revoked)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          hashProof(value),
          session.session_reference,
          session.account_reference,
          workspaceReference,
          generation,
          Number(session.epoch_at_issue),
          Number(session.created_at_ms),
          Number(session.last_seen_at_ms),
          Number(session.absolute_expiry_ms),
          session.revoked,
        ],
      );
      const requestId = this.entropy.token(8);
      return {
        proof: { kind: "SessionProof", value },
        viewer: buildWorkspaceViewer({
          workspaceReference,
          accountReference: session.account_reference,
          sessionReference: session.session_reference,
          generation,
          authorizationEpoch: Number(account.authorization_epoch),
          membershipRevision: Number(account.membership_revision),
          requestId,
        }),
      };
    });
  }

  async addWorkspace(accountReference: string, workspaceReference: string): Promise<void> {
    // Mirror the in-memory no-op when the account is missing; idempotent when the workspace exists.
    await this.pool.query(
      `INSERT INTO identity_account_workspace (account_reference, workspace_reference)
       SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM identity_account WHERE account_reference = $1)
       ON CONFLICT DO NOTHING`,
      [accountReference, workspaceReference],
    );
  }

  async workspacesOf(accountReference: string, tx?: Executor): Promise<string[]> {
    // Given the erase transaction's client, read within it (after the account FOR UPDATE lock) so a
    // stale pre-transaction snapshot cannot drop a workspace from the SEC-09 cascade.
    return this.#workspacesOf((tx as PoolClient | undefined) ?? this.pool, accountReference);
  }

  async accountSecurityRevision(accountReference: string): Promise<number> {
    const row = (await this.pool.query<{ security_revision: string }>("SELECT security_revision FROM identity_account WHERE account_reference = $1", [accountReference])).rows[0];
    return row ? Number(row.security_revision) : 0;
  }

  async bumpSecurityRevision(accountReference: string): Promise<number> {
    const row = (await this.pool.query<{ security_revision: string }>(
      "UPDATE identity_account SET security_revision = security_revision + 1 WHERE account_reference = $1 RETURNING security_revision",
      [accountReference],
    )).rows[0];
    return row ? Number(row.security_revision) : 0;
  }

  async setAccountState(accountReference: string, state: AccountState): Promise<void> {
    await this.pool.query("UPDATE identity_account SET state = $2, authorization_epoch = authorization_epoch + 1 WHERE account_reference = $1", [accountReference, state]);
  }

  // One transaction the erasure command drives so the identity fence and every participant's cache
  // shred commit together (ticket 23 slice 3b-vi). Store methods given this client join the txn.
  withUnitOfWork<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, (client) => fn(client));
  }

  async erase(accountReference: string, tx?: Executor): Promise<number> {
    return withExecutor(this.pool, tx, async (client) => {
      // Lock the account row first so a concurrent issueSession serializes behind this erase.
      const acct = await client.query("SELECT account_reference FROM identity_account WHERE account_reference = $1 FOR UPDATE", [accountReference]);
      if ((acct.rowCount ?? 0) === 0) return 0;
      const fence = Number((await client.query<{ f: string }>("SELECT nextval('identity_fence_seq') AS f")).rows[0]!.f);
      // Monotonic: a re-erase raises the fence, a restore can never lower it.
      await client.query(
        `INSERT INTO identity_account_fence (account_reference, fence) VALUES ($1, $2)
         ON CONFLICT (account_reference) DO UPDATE SET fence = GREATEST(identity_account_fence.fence, EXCLUDED.fence)`,
        [accountReference, fence],
      );
      await client.query(
        "UPDATE identity_account SET state = 'closed', authorization_epoch = authorization_epoch + 1, security_revision = security_revision + 1 WHERE account_reference = $1",
        [accountReference],
      );
      await client.query("DELETE FROM identity_session WHERE account_reference = $1", [accountReference]);
      const eff = await client.query<{ fence: string }>("SELECT fence FROM identity_account_fence WHERE account_reference = $1", [accountReference]);
      return Number(eff.rows[0]!.fence);
    });
  }

  async isErasedAccount(accountReference: string): Promise<boolean> {
    return ((await this.pool.query("SELECT 1 FROM identity_account_fence WHERE account_reference = $1", [accountReference])).rowCount ?? 0) > 0;
  }

  async fenceFor(accountReference: string): Promise<number> {
    const row = (await this.pool.query<{ fence: string }>("SELECT fence FROM identity_account_fence WHERE account_reference = $1", [accountReference])).rows[0];
    return row ? Number(row.fence) : 0;
  }

  async accountState(accountReference: string): Promise<AccountState | undefined> {
    const row = (await this.pool.query<{ state: string }>("SELECT state FROM identity_account WHERE account_reference = $1", [accountReference])).rows[0];
    return row ? (row.state as AccountState) : undefined;
  }

  async getReceipt(kind: ReceiptKind, proofHash: string, idempotencyKey: string): Promise<StoredReceipt | undefined> {
    const row = (await this.pool.query<{ payload_hash: string; outcome: unknown }>(
      "SELECT payload_hash, outcome FROM identity_receipt WHERE kind = $1 AND proof_hash = $2 AND idempotency_key = $3",
      [kind, proofHash, idempotencyKey],
    )).rows[0];
    return row ? { payloadHash: row.payload_hash, outcome: row.outcome } : undefined;
  }

  async putReceipt(kind: ReceiptKind, proofHash: string, idempotencyKey: string, payloadHash: string, outcome: unknown): Promise<void> {
    // The (kind, proof_hash, idempotency_key) PK makes a re-put a no-op (first-writer-wins) — the
    // replay-vs-conflict decision is the caller's, via payload_hash. Never double-inserts.
    await this.pool.query(
      `INSERT INTO identity_receipt (kind, proof_hash, idempotency_key, payload_hash, outcome)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [kind, proofHash, idempotencyKey, payloadHash, JSON.stringify(outcome)],
    );
  }
}
