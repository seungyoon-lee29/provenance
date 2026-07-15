import type {
  AccountAuthorizationEpoch,
  AccountReference,
  AdministrativeErasureReference,
  ContractValue,
  MembershipRevision,
  Revision,
  SessionGeneration,
  SessionReference,
  WorkspaceReference,
} from "../../shared/contracts";

// Deterministic seams (mirrors F1/F2 ChartClock/ManualClock): no Date.now()/Math.random() in module logic.
export interface IdentityClock {
  now(): number;
}

export interface EntropySource {
  /** Opaque, unguessable value (base32/hex). Deterministic double in tests. */
  token(byteLength?: number): string;
}

export type SessionProof = ContractValue<"SessionProof"> & {
  /** Opaque secret the client holds; the server keeps only its hash. */
  readonly value: string;
};

export type ClientProof = ContractValue<"ClientProof"> & {
  readonly requestId: string;
  readonly method: "GET" | "POST";
  readonly sameOrigin: boolean;
  readonly origin: string;
};

export type InternalRoute = ContractValue<"InternalRoute"> & { readonly path: string };
export type ReauthenticationProof = ContractValue<"ReauthenticationProof"> & { readonly value: string };

export type AccountEmailPurpose = "verify_email" | "recover" | "sign_in";

export type AccountEmailCommand = ContractValue<"AccountEmailCommand"> & {
  readonly purpose: AccountEmailPurpose;
  readonly email: string;
};

export type AccountEmailOutcome = ContractValue<"AccountEmailOutcome"> & {
  // enumeration-safe: eligible and ineligible requests return the same status/shape/timing class.
  // "rejected" is only for CSRF/method violations (a different axis from account existence).
  readonly status: "challenge_issued" | "conflict" | "rejected";
  readonly receiptId: string;
  readonly revision?: Revision;
};

export type SessionOutcome = ContractValue<"SessionOutcome"> & {
  readonly status: "issued" | "revoked" | "denied" | "locked" | "expired" | "conflict" | "rejected";
  readonly sessionProof?: SessionProof;
  readonly viewer?: WorkspaceViewerContextShape;
  readonly revision?: Revision;
};

// The concrete workspace viewer the store issues (structurally the shared WorkspaceViewerContext).
export type WorkspaceViewerContextShape = Readonly<{
  kind: "workspace";
  requestId: string;
  workspaceReference: WorkspaceReference;
  accountReference: AccountReference;
  sessionReference: SessionReference;
  sessionGeneration: SessionGeneration;
  accountAuthorizationEpoch: AccountAuthorizationEpoch;
  membershipRevision: MembershipRevision;
}>;

export type FederatedSignInIntent = ContractValue<"FederatedSignInIntent"> & {
  readonly provider: "google" | "github";
  readonly authorizationUrl: string;
  readonly state: string;
  readonly pkceChallenge: string;
  readonly nonce?: string;
  readonly expiresAtMs: number;
};

export type FederatedCallbackProof = ContractValue<"FederatedCallbackProof"> & {
  readonly state: string;
  readonly code: string;
  readonly callbackOrigin: string;
  /** Scripted OIDC id_token (google) — never persisted or logged. */
  readonly assertion?: string;
};

export type ErasureCommandOutcome = ContractValue<"ErasureCommandOutcome"> & {
  readonly status: "accepted" | "conflict" | "rejected" | "denied";
  readonly erasureReference?: AdministrativeErasureReference;
  readonly fence?: string;
  readonly revision?: Revision;
};
