import { createHash } from "node:crypto";

import { brandReference } from "../../shared/contracts/brands";
import type { AccountReference, WorkspaceReference } from "../../shared/contracts";
import type { GuestViewerContext, ViewerContext } from "../../shared/contracts/viewer-context";
import type { EntropySource, IdentityClock, SessionProof, WorkspaceViewerContextShape } from "./contracts";

// ponytail: fixed session windows; make them per-policy knobs when a real policy engine lands.
const ABSOLUTE_EXPIRY_MS = 12 * 60 * 60 * 1000;
const IDLE_EXPIRY_MS = 30 * 60 * 1000;

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

export type IssuedSession = Readonly<{ proof: SessionProof; viewer: WorkspaceViewerContextShape }>;

/**
 * In-memory, hash-only session + account registry (network-off lane).
 * SEC-01: only this store mints a Viewer Context. SEC-08: proofs are opaque, stored as hashes,
 * and bound to session generation + account authorization epoch.
 */
export class IdentitySessionStore {
  readonly #accounts = new Map<string, AccountRecord>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #erasedAccounts = new Map<string, number>(); // accountReference → monotonic deletion fence
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

  ensureEmailAccount(email: string): AccountRecord {
    return this.findEmailAccount(email) ?? this.#createAccount({ emailKey: email.trim().toLowerCase(), emailVerified: true });
  }

  createPendingEmailAccount(email: string): AccountRecord {
    return this.#createAccount({ emailKey: email.trim().toLowerCase(), emailVerified: false });
  }

  findEmailAccount(email: string): AccountRecord | undefined {
    const emailKey = email.trim().toLowerCase();
    for (const account of this.#accounts.values()) {
      if (account.emailKey === emailKey) return account;
    }
    return undefined;
  }

  markEmailVerified(accountReference: string): void {
    const account = this.#account(accountReference);
    if (account !== undefined) account.emailVerified = true;
  }

  ensureFederatedAccount(identityKey: string): AccountRecord {
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

  primaryWorkspace(account: AccountRecord): string {
    const first = [...account.workspaces][0];
    if (first === undefined) throw new Error("account has no workspace");
    return first;
  }

  #viewer(session: SessionRecord, account: AccountRecord, requestId: string): WorkspaceViewerContextShape {
    return {
      kind: "workspace",
      requestId,
      workspaceReference: brandReference<string, "WorkspaceReference">(session.workspaceReference),
      accountReference: brandReference<string, "AccountReference">(account.accountReference),
      sessionReference: brandReference<string, "SessionReference">(session.sessionReference),
      sessionGeneration: brandReference<string, "SessionGeneration">(String(session.generation)),
      accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">(String(account.authorizationEpoch)),
      membershipRevision: brandReference<string, "MembershipRevision">(String(account.membershipRevision)),
    };
  }

  issueSession(accountReference: AccountReference | string, workspaceReference: WorkspaceReference | string): IssuedSession {
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
    if (record === undefined || record.revoked) return undefined;
    if (this.#erasedAccounts.has(record.accountReference)) return undefined; // monotonic fence overrides any restore
    const account = this.#account(record.accountReference);
    if (account === undefined || account.state !== "active") return undefined;
    if (record.epochAtIssue !== account.authorizationEpoch) return undefined;
    const now = this.clock.now();
    if (now > record.absoluteExpiryMs || now - record.lastSeenAtMs > IDLE_EXPIRY_MS) return undefined;
    return { record, account };
  }

  resolve(proof: SessionProof): ViewerContext {
    const requestId = this.entropy.token(8);
    const live = this.#liveSession(proof);
    if (live === undefined) return this.#guest(requestId);
    live.record.lastSeenAtMs = this.clock.now();
    return this.#viewer(live.record, live.account, requestId);
  }

  /** `scope=current`: revoke only this session row; other sessions survive. */
  revokeCurrent(proof: SessionProof): boolean {
    const record = this.#sessions.get(hashProof(proof.value));
    if (record === undefined || record.revoked) return false;
    record.revoked = true;
    return true;
  }

  /** `scope=all`: bump account authorization epoch so every session's resolve fails. */
  revokeAll(accountReference: string): void {
    const account = this.#account(accountReference);
    if (account === undefined) return;
    account.authorizationEpoch += 1;
    account.securityRevision += 1;
  }

  /** Workspace switch: rotate this session (new proof + generation), swap the current workspace. */
  switchWorkspace(proof: SessionProof, workspaceReference: string): IssuedSession | undefined {
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

  addWorkspace(accountReference: string, workspaceReference: string): void {
    this.#account(accountReference)?.workspaces.add(workspaceReference);
  }

  /** Every workspace owned by the account — the cascade target for account-scope erasure (SEC-09). */
  workspacesOf(accountReference: string): string[] {
    return [...(this.#account(accountReference)?.workspaces ?? [])];
  }

  accountSecurityRevision(accountReference: string): number {
    return this.#account(accountReference)?.securityRevision ?? 0;
  }

  bumpSecurityRevision(accountReference: string): number {
    const account = this.#account(accountReference);
    if (account === undefined) return 0;
    account.securityRevision += 1;
    return account.securityRevision;
  }

  setAccountState(accountReference: string, state: AccountState): void {
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
  erase(accountReference: string): number {
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

  isErasedAccount(accountReference: string): boolean {
    return this.#erasedAccounts.has(accountReference);
  }

  fenceFor(accountReference: string): number {
    return this.#erasedAccounts.get(accountReference) ?? 0;
  }

  accountState(accountReference: string): AccountState | undefined {
    return this.#account(accountReference)?.state;
  }
}
