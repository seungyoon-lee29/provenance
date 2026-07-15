import { assertSafeComposition, buildCompositionManifest } from "./manifest";
import { loadLocalCredentialKeyring } from "../platform/credential-vault";
import { loadLocalDeliveryKeyring } from "./local-delivery-keyring";
import { loadRuntimeConfig } from "./runtime-policy";

export function bootstrapComposition(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const config = loadRuntimeConfig(environment);
  const manifest = buildCompositionManifest(config);
  assertSafeComposition(config, manifest);
  const credentialKeyring = config.credentialVaultProvider === "local"
    ? loadLocalCredentialKeyring(config.credentialLocalKeyringFile)
    : undefined;
  const deliveryKeyring = config.deliveryKeyringProvider === "local" && config.emailDeliveryProvider !== "disabled"
    ? loadLocalDeliveryKeyring(config.deliveryLocalKeyringFile, config.emailDeliveryProvider)
    : undefined;
  return { config, manifest, credentialKeyring, deliveryKeyring } as const;
}
