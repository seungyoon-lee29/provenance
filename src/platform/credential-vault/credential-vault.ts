import "server-only";
import { randomBytes } from "node:crypto";

import { brandReference } from "../../shared/contracts/brands";
import { encodeCredentialAad } from "./aad";
import { openAes256Gcm, sealAes256Gcm } from "./crypto";
import type { CredentialKeyring } from "./keyring";
import type { CredentialAadContext, CredentialEnvelope, NonceSource } from "./types";

export class CredentialVault {
  readonly #usedNonces = new Set<string>();

  constructor(
    private readonly keyring: CredentialKeyring,
    private readonly nonceSource: NonceSource = () => randomBytes(12),
  ) {}

  seal(plaintext: Uint8Array, context: CredentialAadContext): CredentialEnvelope {
    const active = this.keyring.active();
    const nonce = this.nonceSource();
    if (nonce.byteLength !== 12) throw new Error("credential encryption unavailable");
    const nonceIdentity = `${active.version}:${Buffer.from(nonce).toString("base64")}`;
    if (this.#usedNonces.has(nonceIdentity)) throw new Error("credential encryption unavailable");
    this.#usedNonces.add(nonceIdentity);
    const sealed = sealAes256Gcm(active.key, nonce, plaintext, encodeCredentialAad(context));
    return {
      schemaVersion: 1,
      algorithm: "A256GCM",
      keyVersion: active.version,
      nonceBase64: Buffer.from(nonce).toString("base64"),
      ciphertextBase64: Buffer.from(sealed.ciphertext).toString("base64"),
      tagBase64: Buffer.from(sealed.tag).toString("base64"),
    };
  }

  open(envelope: CredentialEnvelope, context: CredentialAadContext): Uint8Array {
    try {
      if (envelope.schemaVersion !== 1 || envelope.algorithm !== "A256GCM") throw new Error("unsupported envelope");
      const key = this.keyring.readable(brandReference<string, "VaultKeyVersion">(envelope.keyVersion));
      return openAes256Gcm(
        key.key,
        Buffer.from(envelope.nonceBase64, "base64"),
        Buffer.from(envelope.ciphertextBase64, "base64"),
        Buffer.from(envelope.tagBase64, "base64"),
        encodeCredentialAad(context),
      );
    } catch {
      throw new Error("credential decryption unavailable");
    }
  }

  async rewrap(envelope: CredentialEnvelope, context: CredentialAadContext, replace: (candidate: CredentialEnvelope) => Promise<void>): Promise<void> {
    const plaintext = this.open(envelope, context);
    try {
      const candidate = this.seal(plaintext, context);
      await replace(candidate);
    } finally {
      plaintext.fill(0);
    }
  }
}
