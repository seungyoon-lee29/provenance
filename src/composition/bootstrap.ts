import { assertSafeComposition, buildCompositionManifest } from "./manifest";
import { loadLocalCredentialKeyring } from "../platform/credential-vault";
import { loadRuntimeConfig } from "./runtime-policy";

export function bootstrapComposition(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const config = loadRuntimeConfig(environment);
  const manifest = buildCompositionManifest(config);
  assertSafeComposition(config, manifest);
  const credentialKeyring = config.credentialVaultProvider === "local"
    ? loadLocalCredentialKeyring(config.credentialLocalKeyringFile)
    : undefined;
  return { config, manifest, credentialKeyring } as const;
}
