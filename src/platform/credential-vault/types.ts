import "server-only";
import type { ProviderConnectionReference, VaultKeyVersion, WorkspaceReference } from "../../shared/contracts";

export type ProviderEnvironment = "paper" | "live";
export type CredentialPurpose = "provider_credential";

export type CredentialAadContext = Readonly<{
  purpose: CredentialPurpose;
  workspaceReference: WorkspaceReference;
  providerConnectionReference: ProviderConnectionReference;
  provider: string;
  credentialType: string;
  environment: ProviderEnvironment;
}>;

export type CredentialEnvelope = Readonly<{
  schemaVersion: 1;
  algorithm: "A256GCM";
  keyVersion: VaultKeyVersion;
  nonceBase64: string;
  ciphertextBase64: string;
  tagBase64: string;
}>;

export type VaultKey = Readonly<{
  version: VaultKeyVersion;
  status: "active" | "previous";
  key: Uint8Array;
  notAfter?: Date;
}>;

export type NonceSource = () => Uint8Array;
