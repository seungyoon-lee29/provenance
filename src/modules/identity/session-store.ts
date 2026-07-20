import { createHash } from "node:crypto";

import { brandReference } from "../../shared/contracts/brands";
import type { AccountReference, WorkspaceReference } from "../../shared/contracts";
import type { GuestViewerContext, ViewerContext } from "../../shared/contracts/viewer-context";
import type { Executor } from "../../platform/persistence/pg";
import type { EntropySource, IdentityClock, SessionProof, WorkspaceViewerContextShape } from "./contracts";

// ponytail: fixed session windows; make them per-policy knobs when a real policy engine lands.
// Exported so every IdentityStore impl (in-memory, pg) honours the SAME expiry policy and the
// contract suite can assert it without hard-coding the window.
export const ABSOLUTE_EXPIRY_MS = 12 * 60 * 60 * 1000;
export const IDLE_EXPIRY_MS = 30 * 60 * 1000;

export type AccountState = "active" | "suspended" | "closed";

export type AccountRecord = {
  accountReference: string;
  authorizationEpoch: number;
  membershipRevision: number;
  securityRevision: number;
  state: AccountState;
  workspaces: Set<string>;
  emailKey?: string;
  identityKey?: string;
  emailVerified: boolean;
};

type SessionRecord = {
  sessionHash: string;
  sessionReference: string;
  accountReference: string;
  workspaceReference: string;
  generation: number;
  epochAtIssue: number;
  createdAtMs: number;
  lastSeenAtMs: number;
  absoluteExpiryMs: number;
  revoked: boolean;
};

export function hashProof(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * SEC-08 session liveness — the single predicate BOTH the in-memory and pg impls apply, so the
 * revoked/fence/epoch/expiry semantics can never diverge. Expiry is judged on the injected clock's
 * `nowMs` (never SQL now()). `isFenced` short-circuits any session of an erased account, so a stale
 * backup restore that re-activates the account row can never resurrect the session.
 */
export function sessionIsLive(input: Readonly<{
  revoked: boolean;
  epochAtIssue: number;
  absoluteExpiryMs: number;
  lastSeenAtMs: number;
  accountState: AccountState | undefined;
  accountAuthorizationEpoch: number | undefined;
  isFenced: boolean;
  nowMs: number;
}>): boolean {
  if (input.revoked || input.isFenced) return false;
  if (input.accountState !== "active") return false;
  if (input.epochAtIssue !== input.accountAuthorizationEpoch) return false;
  if (input.nowMs > input.absoluteExpiryMs || input.nowMs - input.lastSeenAtMs > IDLE_EXPIRY_MS) return false;
  return true;
}

/** The Workspace Viewer Context shape both impls mint (SEC-01: only the store issues one). */
export function buildWorkspaceViewer(input: Readonly<{
  workspaceReference: string;
  accountReference: string;
  sessionReference: string;
  generation: number;
  authorizationEpoch: number;
  membershipRevision: number;
  requestId: string;
}>): WorkspaceViewerContextShape {
  return {
    kind: "workspace",
    requestId: input.requestId,
    workspaceReference: brandReference<string, "WorkspaceReference">(input.workspaceReference),
    accountReference: brandReference<string, "AccountReference">(input.accountReference),
    sessionReference: brandReference<string, "SessionReference">(input.sessionReference),
    sessionGeneration: brandReference<string, "SessionGeneration">(String(input.generation)),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">(String(input.authorizationEpoch)),
    membershipRevision: brandReference<string, "MembershipRevision">(String(input.membershipRevision)),
  };
}

export type IssuedSession = Readonly<{ proof: SessionProof; viewer: WorkspaceViewerContextShape }>;

/** Durable idempotency receipts for the destructive commands (ticket 23 slice 3b-iii-b). */
export type ReceiptKind = "revoke" | "erase";
export type StoredReceipt = Readonly<{ payloadHash: string; outcome: unknown }>;

/**
 * Persistence seam for the Identity spine (ticket 23). The in-memory impl below and a pg impl
 * (slice 3b-iii) must satisfy the SAME parameterized contract suite so their null/ordering/fence/
 * expiry semantics cannot silently diverge. Consumers (IdentityService, challenge, federated,
 * composition) depend on this interface, so the running stack can swap in the pg impl.
 */
export interface IdentityStore {
  ensureEmailAccount(email: string): Promise<AccountRecord>;
  createPendingEmailAccount(email: string): Promise<AccountRecord>;
  findEmailAccount(email: string): Promise<AccountRecord | undefined>;
  markEmailVerified(accountReference: string): Promise<void>;
  ensureFederatedAccount(identityKey: string): Promise<AccountRecord>;
  primaryWorkspace(account: AccountRecord): Promise<string>;
  issueSession(accountReference: AccountReference | string, workspaceReference: WorkspaceReference | string): Promise<IssuedSession>;
  resolve(proof: SessionProof): Promise<ViewerContext>;
  revokeCurrent(proof: SessionProof): Promise<boolean>;
  revokeAll(accountReference: string): Promise<void>;
  switchWorkspace(proof: SessionProof, workspaceReference: string): Promise<IssuedSession | undefined>;
  addWorkspace(accountReference: string, workspaceReference: string): Promise<void>;
  /**
   * Every workspace the account owns — the account-scope erasure cascade target (SEC-09). Accepts
   * the erase transaction (`tx`) so the cascade reads the set INSIDE the fenced transaction, after
   * the account row is locked, rather than from a stale pre-transaction snapshot (ticket 23 3b-vi).
   */
  workspacesOf(accountReference: string, tx?: Executor): Promise<string[]>;
  accountSecurityRevision(accountReference: string): Promise<number>;
  bumpSecurityRevision(accountReference: string): Promise<number>;
  setAccountState(accountReference: string, state: AccountState): Promise<void>;
  /**
   * Run `fn` in one atomic unit of work (ticket 23 slice 3b-vi). The pg impl opens a single
   * transaction and hands its client through `tx`; the in-memory impl runs `fn` directly with an
   * undefined `tx`. The erasure command uses this to commit the identity deletion fence and every
   * participant's cache shred together — a crash mid-erase leaves zero durable partial state (no
   * physical PII residue behind an already-committed fence). Store methods that accept `tx` join
   * the caller's transaction; passed no `tx`, they open their own.
   */
  withUnitOfWork<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  erase(accountReference: string, tx?: Executor): Promise<number>;
  isErasedAccount(accountReference: string): Promise<boolean>;
  fenceFor(accountReference: string): Promise<number>;
  accountState(accountReference: string): Promise<AccountState | undefined>;
  /**
   * Durable idempotency receipts for revoke/erasure. Keyed by (kind, proofHash, idempotencyKey) —
   * the command shreds its own session, so a retry carries a now-dead proof that can never be
   * re-resolved to an account; the receipt must be findable pre-resolve by the proof hash it was
   * issued under. `payloadHash` is stored separately (never in the key) so the caller can replay on
   * a match and reject a same-key/different-payload retry as a side-effect-free conflict (SEC design #3).
   */
  getReceipt(kind: ReceiptKind, proofHash: string, idempotencyKey: string): Promise<StoredReceipt | undefined>;
  putReceipt(kind: ReceiptKind, proofHash: string, idempotencyKey: string, payloadHash: string, outcome: unknown): Promise<void>;
}

/**
 * In-memory, hash-only session + account registry (network-off lane).
 * SEC-01: only this store mints a Viewer Context. SEC-08: proofs are opaque, stored as hashes,
 * and bound to session generation + account authorization epoch.
 *
 * Public methods are async so a pg-backed impl (ticket 23) is a drop-in behind the same seam;
 * the in-memory backing resolves synchronously under the hood. Private helpers stay sync until
 * their state moves to postgres.
 */
export class IdentitySessionStore implements IdentityStore {
  readonly #accounts = new Map<string, AccountRecord>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #erasedAccounts = new Map<string, number>(); // accountReference → monotonic deletion fence
  readonly #receipts = new Map<string, StoredReceipt>(); // `${kind}:${proofHash}:${idempotencyKey}` → receipt
  #globalFence = 0;

  constructor(
    private readonly clock: IdentityClock,
    private readonly entropy: EntropySource,
  ) {}

  #guest(requestId: string): GuestViewerContext {
    return { kind: "guest", requestId };
  }

  #account(accountReference: string): AccountRecord | undefined {
    return this.#accounts.get(accountReference);
  }

  async ensureEmailAccount(email: string): Promise<AccountRecord> {
    return (await this.findEmailAccount(email)) ?? this.#createAccount({ emailKey: email.trim().toLowerCase(), emailVerified: true });
  }

  async createPendingEmailAccount(email: string): Promise<AccountRecord> {
    return this.#createAccount({ emailKey: email.trim().toLowerCase(), emailVerified: false });
  }

  async findEmailAccount(email: string): Promise<AccountRecord | undefined> {
    const emailKey = email.trim().toLowerCase();
    for (const account of this.#accounts.values()) {
      if (account.emailKey === emailKey) return account;
    }
    return undefined;
  }

  async markEmailVerified(accountReference: string): Promise<void> {
    const account = this.#account(accountReference);
    if (account !== undefined) account.emailVerified = true;
  }

  async ensureFederatedAccount(identityKey: string): Promise<AccountRecord> {
    for (const account of this.#accounts.values()) {
      if (account.identityKey === identityKey) return account; // erased account survives as a closed tombstone
    }
    return this.#createAccount({ identityKey, emailVerified: true });
  }

  #createAccount(seed: { emailKey?: string; identityKey?: string; emailVerified: boolean }): AccountRecord {
    const accountReference = `account:${this.entropy.token(16)}`;
    const workspaceReference = `workspace:${this.entropy.token(16)}`;
    const account: AccountRecord = {
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
    this.#accounts.set(accountReference, account);
    return account;
  }

  async primaryWorkspace(account: AccountRecord): Promise<string> {
    const first = [...account.workspaces][0];
    if (first === undefined) throw new Error("account has no workspace");
    return first;
  }

  #viewer(session: SessionRecord, account: AccountRecord, requestId: string): WorkspaceViewerContextShape {
    return buildWorkspaceViewer({
      workspaceReference: session.workspaceReference,
      accountReference: account.accountReference,
      sessionReference: session.sessionReference,
      generation: session.generation,
      authorizationEpoch: account.authorizationEpoch,
      membershipRevision: account.membershipRevision,
      requestId,
    });
  }

  async issueSession(accountReference: AccountReference | string, workspaceReference: WorkspaceReference | string): Promise<IssuedSession> {
    const account = this.#account(String(accountReference));
    if (account === undefined) throw new Error("unknown account");
    if (account.state !== "active" || this.#erasedAccounts.has(account.accountReference)) throw new Error("account cannot receive a session");
    if (!account.workspaces.has(String(workspaceReference))) throw new Error("workspace not owned by account");
    const value = this.entropy.token(32);
    const now = this.clock.now();
    const record: SessionRecord = {
      sessionHash: hashProof(value),
      sessionReference: `session:${this.entropy.token(16)}`,
      accountReference: account.accountReference,
      workspaceReference: String(workspaceReference),
      generation: 1,
      epochAtIssue: account.authorizationEpoch,
      createdAtMs: now,
      lastSeenAtMs: now,
      absoluteExpiryMs: now + ABSOLUTE_EXPIRY_MS,
      revoked: false,
    };
    this.#sessions.set(record.sessionHash, record);
    const proof: SessionProof = { kind: "SessionProof", value };
    const requestId = this.entropy.token(8);
    return { proof, viewer: this.#viewer(record, account, requestId) };
  }

  #liveSession(proof: SessionProof): { record: SessionRecord; account: AccountRecord } | undefined {
    const record = this.#sessions.get(hashProof(proof.value));
    if (record === undefined) return undefined;
    const account = this.#account(record.accountReference);
    const live = sessionIsLive({
      revoked: record.revoked,
      epochAtIssue: record.epochAtIssue,
      absoluteExpiryMs: record.absoluteExpiryMs,
      lastSeenAtMs: record.lastSeenAtMs,
      accountState: account?.state,
      accountAuthorizationEpoch: account?.authorizationEpoch,
      isFenced: this.#erasedAccounts.has(record.accountReference), // monotonic fence overrides any restore
      nowMs: this.clock.now(),
    });
    if (!live || account === undefined) return undefined;
    return { record, account };
  }

  async resolve(proof: SessionProof): Promise<ViewerContext> {
    const requestId = this.entropy.token(8);
    const live = this.#liveSession(proof);
    if (live === undefined) return this.#guest(requestId);
    live.record.lastSeenAtMs = this.clock.now();
    return this.#viewer(live.record, live.account, requestId);
  }

  /** `scope=current`: revoke only this session row; other sessions survive. */
  async revokeCurrent(proof: SessionProof): Promise<boolean> {
    const record = this.#sessions.get(hashProof(proof.value));
    if (record === undefined || record.revoked) return false;
    record.revoked = true;
    return true;
  }

  /** `scope=all`: bump account authorization epoch so every session's resolve fails. */
  async revokeAll(accountReference: string): Promise<void> {
    const account = this.#account(accountReference);
    if (account === undefined) return;
    account.authorizationEpoch += 1;
    account.securityRevision += 1;
  }

  /** Workspace switch: rotate this session (new proof + generation), swap the current workspace. */
  async switchWorkspace(proof: SessionProof, workspaceReference: string): Promise<IssuedSession | undefined> {
    const live = this.#liveSession(proof);
    if (live === undefined) return undefined;
    const { record, account } = live;
    if (!account.workspaces.has(workspaceReference)) return undefined;
    this.#sessions.delete(record.sessionHash);
    const value = this.entropy.token(32);
    const rotated: SessionRecord = {
      ...record,
      sessionHash: hashProof(value),
      workspaceReference,
      generation: record.generation + 1,
    };
    this.#sessions.set(rotated.sessionHash, rotated);
    const requestId = this.entropy.token(8);
    return { proof: { kind: "SessionProof", value }, viewer: this.#viewer(rotated, account, requestId) };
  }

  async addWorkspace(accountReference: string, workspaceReference: string): Promise<void> {
    this.#account(accountReference)?.workspaces.add(workspaceReference);
  }

  /** Every workspace owned by the account — the cascade target for account-scope erasure (SEC-09). */
  async workspacesOf(accountReference: string, _tx?: Executor): Promise<string[]> {
    return [...(this.#account(accountReference)?.workspaces ?? [])];
  }

  async accountSecurityRevision(accountReference: string): Promise<number> {
    return this.#account(accountReference)?.securityRevision ?? 0;
  }

  async bumpSecurityRevision(accountReference: string): Promise<number> {
    const account = this.#account(accountReference);
    if (account === undefined) return 0;
    account.securityRevision += 1;
    return account.securityRevision;
  }

  async setAccountState(accountReference: string, state: AccountState): Promise<void> {
    const account = this.#account(accountReference);
    if (account === undefined) return;
    account.state = state;
    account.authorizationEpoch += 1;
  }

  /**
   * SEC-09 erasure: commit a monotonic deletion fence, close the account, and crypto-shred its
   * session rows. The fence is durable coordinator state — a later restore that re-activates the
   * account row is still overridden by the fence in `#liveSession`.
   */
  // In-memory has no transaction to open: run the unit of work directly. RAM is all-or-nothing per
  // process, so the durable-atomicity the pg impl provides is vacuous here (a crash loses it all).
  withUnitOfWork<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    return fn(undefined);
  }

  async erase(accountReference: string, _tx?: Executor): Promise<number> {
    const account = this.#account(accountReference);
    if (account === undefined) return 0;
    this.#globalFence += 1;
    this.#erasedAccounts.set(accountReference, this.#globalFence);
    account.state = "closed";
    account.authorizationEpoch += 1;
    account.securityRevision += 1;
    for (const [hashKey, record] of this.#sessions) {
      if (record.accountReference === accountReference) this.#sessions.delete(hashKey);
    }
    return this.#globalFence;
  }

  async isErasedAccount(accountReference: string): Promise<boolean> {
    return this.#erasedAccounts.has(accountReference);
  }

  async fenceFor(accountReference: string): Promise<number> {
    return this.#erasedAccounts.get(accountReference) ?? 0;
  }

  async accountState(accountReference: string): Promise<AccountState | undefined> {
    return this.#account(accountReference)?.state;
  }

  async getReceipt(kind: ReceiptKind, proofHash: string, idempotencyKey: string): Promise<StoredReceipt | undefined> {
    return this.#receipts.get(`${kind}:${proofHash}:${idempotencyKey}`);
  }

  async putReceipt(kind: ReceiptKind, proofHash: string, idempotencyKey: string, payloadHash: string, outcome: unknown): Promise<void> {
    const key = `${kind}:${proofHash}:${idempotencyKey}`;
    if (!this.#receipts.has(key)) this.#receipts.set(key, { payloadHash, outcome }); // first-writer-wins, mirrors pg ON CONFLICT DO NOTHING
  }
}
