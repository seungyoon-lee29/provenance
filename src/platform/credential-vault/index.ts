export { encodeCredentialAad } from "./aad";
export { CredentialVault } from "./credential-vault";
export { openAes256Gcm, sealAes256Gcm } from "./crypto";
export { CredentialKeyring } from "./keyring";
export { loadLocalCredentialKeyring } from "./local-keyring";
export type { CredentialAadContext, CredentialEnvelope, CredentialPurpose, NonceSource, ProviderEnvironment, VaultKey } from "./types";
