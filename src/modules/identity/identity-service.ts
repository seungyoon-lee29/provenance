import { brandReference } from "../../shared/contracts/brands";
import type { MutationControl } from "../../shared/contracts/mutation-control";
import type { ViewerContext } from "../../shared/contracts/viewer-context";
import type {
  AccountEmailCommand,
  AccountEmailOutcome,
  ClientProof,
  EntropySource,
  ErasureCommandOutcome,
  FederatedSignInIntent,
  IdentityClock,
  InternalRoute,
  ReauthenticationProof,
  SessionOutcome,
  SessionProof,
} from "./contracts";
import { EmailChallengeService } from "./email-challenge";
import { FederatedSignInService, type FederatedProvider } from "./federated";
import { IdentitySessionStore, hashProof } from "./session-store";

const REAUTH_TTL_MS = 5 * 60 * 1000;

/** Source modules (ProviderConnections, portfolio, …) that must erase their own state behind the fence. */
export interface ErasureParticipant {
  erase(context: Readonly<{ accountReference: string; workspaceReference: string; scope: "workspace" | "account"; fence: number }>): Promise<void>;
}

type RevokeReceipt = { canonicalHash: string; outcome: SessionOutcome };
type ErasureReceipt = { canonicalHash: string; outcome: ErasureCommandOutcome };

export class IdentityService {
  readonly #reauth = new Map<string, { accountReference: string; expiresAtMs: number }>();
  readonly #revokeReceipts = new Map<string, RevokeReceipt>();
  readonly #erasureReceipts = new Map<string, ErasureReceipt>();

  constructor(
    private readonly store: IdentitySessionStore,
    private readonly clock: IdentityClock,
    private readonly entropy: EntropySource,
    private readonly challenge: EmailChallengeService,
    private readonly federated: FederatedSignInService,
    private readonly participants: readonly ErasureParticipant[] = [],
  ) {}

  resolve(sessionProof: SessionProof): ViewerContext {
    return this.store.resolve(sessionProof);
  }

  requestAccountEmail(command: AccountEmailCommand, control: Readonly<{ idempotencyKey: string }>, clientProof: ClientProof): AccountEmailOutcome {
    return this.challenge.request(command, control, clientProof);
  }

  consumeAccountChallenge(command: Readonly<{ kind: "link" | "manual_code"; proof: string }>, clientProof: ClientProof): SessionOutcome {
    return this.challenge.consume(command, clientProof);
  }

  beginFederatedSignIn(command: Readonly<{ provider: FederatedProvider; returnRoute: InternalRoute }>, clientProof: ClientProof): FederatedSignInIntent {
    return this.federated.begin(command, clientProof);
  }

  consumeFederatedSignIn(command: Readonly<{ provider: FederatedProvider; callbackProof: Parameters<FederatedSignInService["consume"]>[0]["callbackProof"] }>, clientProof: ClientProof): Promise<SessionOutcome> {
    return this.federated.consume(command, clientProof);
  }

  revokeSession(command: Readonly<{ scope: "current" | "all" }>, control: MutationControl, sessionProof: SessionProof): SessionOutcome {
    // Bind the receipt to this proof so two accounts reusing an idempotencyKey string never collide.
    const receiptKey = `${hashProof(sessionProof.value)}:${control.idempotencyKey}`;
    const canonicalHash = hashProof(`revoke ${command.scope}`);
    const prior = this.#revokeReceipts.get(receiptKey);
    if (prior !== undefined) {
      // idempotency short-circuits before resolve so an at-least-once retry with a now-dead session still replays.
      return prior.canonicalHash === canonicalHash ? prior.outcome : { kind: "SessionOutcome", status: "conflict" };
    }
    const viewer = this.store.resolve(sessionProof);
    if (viewer.kind !== "workspace") return { kind: "SessionOutcome", status: "rejected" };
    const accountReference = String(viewer.accountReference);
    const currentRevision = this.store.accountSecurityRevision(accountReference);
    if (String(currentRevision) !== control.expectedRevision) {
      return { kind: "SessionOutcome", status: "rejected", revision: brandReference<string, "Revision">(String(currentRevision)) };
    }

    if (command.scope === "current") this.store.revokeCurrent(sessionProof);
    else this.store.revokeAll(accountReference);
    const revision = this.store.bumpSecurityRevision(accountReference);
    const outcome: SessionOutcome = { kind: "SessionOutcome", status: "revoked", revision: brandReference<string, "Revision">(String(revision)) };
    this.#revokeReceipts.set(receiptKey, { canonicalHash, outcome });
    return outcome;
  }

  /** Re-authentication gate for destructive commands. One-time, account-bound, short TTL. */
  beginReauthentication(sessionProof: SessionProof): ReauthenticationProof | undefined {
    const viewer = this.store.resolve(sessionProof);
    if (viewer.kind !== "workspace") return undefined;
    const value = this.entropy.token(32);
    this.#reauth.set(hashProof(value), { accountReference: String(viewer.accountReference), expiresAtMs: this.clock.now() + REAUTH_TTL_MS });
    return { kind: "ReauthenticationProof", value };
  }

  #consumeReauthentication(accountReference: string, proof: ReauthenticationProof): boolean {
    const key = hashProof(proof.value);
    const entry = this.#reauth.get(key);
    if (entry === undefined || entry.accountReference !== accountReference || this.clock.now() > entry.expiresAtMs) return false;
    this.#reauth.delete(key);
    return true;
  }

  async requestAdministrativeErasure(
    command: Readonly<{ scope: "workspace" | "account"; confirmationProof: ReauthenticationProof }>,
    control: MutationControl,
    sessionProof: SessionProof,
  ): Promise<ErasureCommandOutcome> {
    const receiptKey = `${hashProof(sessionProof.value)}:${control.idempotencyKey}`;
    const canonicalHash = hashProof(`erase ${command.scope}`);
    const prior = this.#erasureReceipts.get(receiptKey);
    if (prior !== undefined) {
      // idempotency short-circuits before resolve: the command shreds this very session, so a retry
      // carries a now-dead proof — it must still replay the original receipt, not fail.
      return prior.canonicalHash === canonicalHash ? prior.outcome : { kind: "ErasureCommandOutcome", status: "conflict" };
    }
    const viewer = this.store.resolve(sessionProof);
    if (viewer.kind !== "workspace") return { kind: "ErasureCommandOutcome", status: "denied" };
    const accountReference = String(viewer.accountReference);
    const workspaceReference = String(viewer.workspaceReference);
    if (!this.#consumeReauthentication(accountReference, command.confirmationProof)) {
      return { kind: "ErasureCommandOutcome", status: "denied" };
    }
    const currentRevision = this.store.accountSecurityRevision(accountReference);
    if (String(currentRevision) !== control.expectedRevision) {
      return { kind: "ErasureCommandOutcome", status: "rejected", revision: brandReference<string, "Revision">(String(currentRevision)) };
    }

    // Commit the monotonic fence + durable intent FIRST, then collect module receipts behind it.
    const fence = this.store.erase(accountReference);
    // Account-scope erasure must fence EVERY workspace the account owns, not just the
    // viewer's current one (SEC-09) — else other workspaces' personal data survives.
    const targetWorkspaces = command.scope === "account" ? this.store.workspacesOf(accountReference) : [workspaceReference];
    for (const participant of this.participants) {
      for (const ws of targetWorkspaces) {
        await participant.erase({ accountReference, workspaceReference: ws, scope: command.scope, fence });
      }
    }
    const revision = this.store.bumpSecurityRevision(accountReference);
    const outcome: ErasureCommandOutcome = {
      kind: "ErasureCommandOutcome",
      status: "accepted",
      erasureReference: brandReference<string, "AdministrativeErasureReference">(`erasure:${this.entropy.token(16)}`),
      fence: String(fence),
      revision: brandReference<string, "Revision">(String(revision)),
    };
    this.#erasureReceipts.set(receiptKey, { canonicalHash, outcome });
    return outcome;
  }
}
