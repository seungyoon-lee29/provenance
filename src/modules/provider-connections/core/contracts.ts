import type {
  ConnectionLifecycleFence,
  CredentialGeneration,
  CredentialVersion,
  ProviderConnectionReference,
  ProviderConnectionOutcome,
  ProviderConnectionView,
  Revision,
  SaveProviderConnection,
  VerifyProviderConnection,
  RevokeProviderConnection,
} from "@/shared";
import type { ProviderEnvironment } from "../../../platform/credential-vault";

export type VerificationState = "unverified" | "verified" | "failed" | "revoked";

/**
 * Masked, secret-free projection of a provider connection. Every field here is
 * safe to serialize to the browser: no plaintext, only status + a last-4 hint.
 */
export type ProviderConnectionMaskedView = ProviderConnectionView &
  Readonly<{
    connectionReference: ProviderConnectionReference;
    provider: string;
    environment: ProviderEnvironment;
    capability: string;
    credentialType: string;
    credentialGeneration: CredentialGeneration;
    credentialVersion: CredentialVersion;
    lifecycleFence: ConnectionLifecycleFence;
    revision: Revision;
    verification: VerificationState;
    maskedHint: string;
  }>;

export type SaveProviderConnectionCommand = SaveProviderConnection &
  Readonly<{
    // null = create a new connection; a reference = rotate the existing one.
    connectionReference: ProviderConnectionReference | null;
    provider: string;
    environment: ProviderEnvironment;
    capability: string;
    credentialType: string;
    secret: string;
  }>;

export type VerifyProviderConnectionCommand = VerifyProviderConnection &
  Readonly<{
    connectionReference: ProviderConnectionReference;
    result: "verified" | "failed";
  }>;

export type RevokeProviderConnectionCommand = RevokeProviderConnection &
  Readonly<{
    connectionReference: ProviderConnectionReference;
  }>;

export type ProviderConnectionReceipt = ProviderConnectionOutcome &
  (
    | Readonly<{
        disposition: "accepted";
        view: ProviderConnectionMaskedView;
        // ponytail: an already-dispatched paper call is left uncertain here;
        // actual reconciliation lands in F8/F9 (broker sync). A flag is enough now.
        submissionUncertainty: boolean;
      }>
    | Readonly<{ disposition: "conflict"; view: ProviderConnectionMaskedView }>
    | Readonly<{ disposition: "rejected"; reason: "stale_revision" | "unauthorized" | "not_found"; currentRevision?: Revision }>
  );
