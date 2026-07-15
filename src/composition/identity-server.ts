import "server-only";

import { randomBytes } from "node:crypto";

import { brandReference } from "@/shared/contracts/brands";
import type { ProviderConnectionReference } from "@/shared/contracts/brands";
import type { ViewerContext } from "@/shared/contracts/viewer-context";
import type { EntropySource, IdentityClock, SessionProof } from "@/modules/identity/contracts";
import { EmailChallengeService } from "@/modules/identity/email-challenge";
import { FederatedSignInService } from "@/modules/identity/federated";
import type { FederatedConfig, FederatedExchangeResult, FederatedProvider } from "@/modules/identity/federated";
import { IdentityService } from "@/modules/identity/identity-service";
import { IdentitySessionStore } from "@/modules/identity/session-store";
import { createProviderConnectionsCore } from "@/modules/provider-connections/core/provider-connections-core";
import type { ProviderConnectionsCore } from "@/modules/provider-connections/core/provider-connections-core";
import { CredentialKeyring, CredentialVault, loadLocalCredentialKeyring } from "@/platform/credential-vault";
import { loadRuntimeConfig } from "./runtime-policy";
import type { RuntimeConfig } from "./runtime-policy";

// Scripted federated adapters for dev/test. Real OAuth (spec §13.1) is opt-in and out of scope:
// a fixed issuer/subject per provider deterministically yields one stable federated account.
const SCRIPTED_ISSUER = "https://identity.local";
const SCRIPTED_SIGNING_KEY = "scripted-identity-key";

function scriptedFederatedConfig(publicOrigin: string): FederatedConfig {
  return {
    publicOrigin,
    google: {
      clientId: "scripted-google",
      callbackPath: "/auth/callback/google",
      authorizationEndpoint: `${publicOrigin}/auth/callback/google`,
      issuer: SCRIPTED_ISSUER,
      signingKey: SCRIPTED_SIGNING_KEY,
    },
    github: {
      clientId: "scripted-github",
      callbackPath: "/auth/callback/github",
      authorizationEndpoint: `${publicOrigin}/auth/callback/github`,
    },
  };
}

// The scripted adapters return a fixed subject per provider; the transport-layer `assertion`/OIDC
// verification is bypassed here since identity trust is the service's job and this lane is network-off.
function scriptedAdapters(): Readonly<Record<FederatedProvider, { exchange: () => Promise<FederatedExchangeResult> }>> {
  return {
    google: { exchange: async () => ({ kind: "subject", issuer: SCRIPTED_ISSUER, subject: "scripted-google-subject" }) },
    github: { exchange: async () => ({ kind: "subject", issuer: "github", subject: "scripted-github-subject" }) },
  };
}

export type IdentitySingleton = Readonly<{
  config: RuntimeConfig;
  identity: IdentityService;
  store: IdentitySessionStore;
  challenge: EmailChallengeService;
  connections: ProviderConnectionsCore;
  vaultDisabled: boolean;
  resolve: (value: string) => ViewerContext;
}>;

const realClock: IdentityClock = { now: () => Date.now() };
const realEntropy: EntropySource = { token: (bytes = 16) => randomBytes(bytes).toString("base64url") };

// ponytail: globalThis-anchored in-memory singleton, mirroring workspace-server.ts — Next.js hands each
// route bundle its own module instance, so a plain module const would not be shared across routes.
const globalStore = globalThis as unknown as { __ftIdentity?: IdentitySingleton };

function buildVault(config: RuntimeConfig): { vault: CredentialVault; disabled: boolean } {
  if (config.credentialVaultProvider === "disabled") {
    // The core still needs a vault to construct; connection saves are gated at the route with
    // configuration_required before this stub is ever reached, so seal() must never be called.
    const stub: CredentialVault = new CredentialVault(
      new CredentialKeyring([
        { version: brandReference<string, "VaultKeyVersion">("stub"), status: "active", key: new Uint8Array(32) },
      ]),
    );
    return { vault: stub, disabled: true };
  }
  const keyring = loadLocalCredentialKeyring(config.credentialLocalKeyringFile);
  return { vault: new CredentialVault(keyring), disabled: false };
}

function build(): IdentitySingleton {
  const config = loadRuntimeConfig(process.env);
  const store = new IdentitySessionStore(realClock, realEntropy);
  const challenge = new EmailChallengeService(store, realClock, realEntropy);
  const federated = new FederatedSignInService(
    store,
    realClock,
    realEntropy,
    scriptedFederatedConfig(config.publicOrigin),
    scriptedAdapters(),
  );
  const identity = new IdentityService(store, realClock, realEntropy, challenge, federated);
  const { vault, disabled } = buildVault(config);
  let sequence = 0;
  const connections = createProviderConnectionsCore({
    vault,
    now: () => Date.now(),
    newConnectionReference: (seed) =>
      brandReference<string, "ProviderConnectionReference">(`connection:${seed}:${(sequence += 1)}`) as ProviderConnectionReference,
  });
  return {
    config,
    identity,
    store,
    challenge,
    connections,
    vaultDisabled: disabled,
    resolve: (value) => identity.resolve({ kind: "SessionProof", value } as SessionProof),
  };
}

export function identityServer(): IdentitySingleton {
  if (globalStore.__ftIdentity !== undefined) return globalStore.__ftIdentity;
  globalStore.__ftIdentity = build();
  return globalStore.__ftIdentity;
}
