import { randomBytes } from "node:crypto";

import { brandReference } from "../../shared/contracts/brands";
import type { Brand, DeliveryEndpointReference } from "../../shared/contracts/brands";
import {
  CredentialKeyring,
  openAes256Gcm,
  sealAes256Gcm,
  type CredentialEnvelope,
  type NonceSource,
} from "../credential-vault";
import { encodeDeliveryAad, type DeliveryAadContext } from "./delivery-aad";

/**
 * F5 delivery secret store (spec §12 line 251, SEC-03/AT-11). Channel endpoints
 * (raw email address / push subscription) and action materials (account
 * challenge verifier, unsubscribe token) are held only as AES-256-GCM envelopes
 * bound to a purpose-specific AAD. This reuses the F0 AES-256-GCM primitive and
 * keyring (NIST-verified); it adds only the delivery AAD domain.
 *
 * There is NO plaintext fallback: if the active key is missing the keyring
 * throws at construction, sealing rejects a bad nonce, and opening throws
 * "delivery decryption unavailable" on any tamper / AAD swap / wrong or expired
 * key. A stored value is always an envelope, never plaintext.
 */
export type DeliveryEnvelope = CredentialEnvelope;

// Same brand symbol as the notification-center module's alias, so these are the
// canonical branded references — declared here to keep the platform vault from
// depending upward on a module.
export type { DeliveryEndpointReference } from "../../shared/contracts/brands";
export type DeliveryActionMaterialReference = Brand<string, "DeliveryActionMaterialReference">;

// The keyring of KEKs the delivery vaults seal against — the F0 keyring reused,
// exposed under the delivery vocabulary (spec names it DeliveryKeyring).
export { CredentialKeyring as DeliveryKeyring } from "../credential-vault";
export type { VaultKey } from "../credential-vault";

export class DeliveryVault {
  readonly #usedNonces = new Set<string>();

  constructor(
    private readonly keyring: CredentialKeyring,
    // ponytail: in-process nonce dedupe for this vault instance's lifetime,
    // matching the F0 CredentialVault; a KEK rotation resets the effective space.
    private readonly nonceSource: NonceSource = () => randomBytes(12),
  ) {}

  seal(plaintext: Uint8Array, context: DeliveryAadContext): DeliveryEnvelope {
    const active = this.keyring.active();
    const nonce = this.nonceSource();
    if (nonce.byteLength !== 12) throw new Error("delivery encryption unavailable");
    const nonceIdentity = `${active.version}:${Buffer.from(nonce).toString("base64")}`;
    if (this.#usedNonces.has(nonceIdentity)) throw new Error("delivery encryption unavailable");
    this.#usedNonces.add(nonceIdentity);
    const sealed = sealAes256Gcm(active.key, nonce, plaintext, encodeDeliveryAad(context));
    return {
      schemaVersion: 1,
      algorithm: "A256GCM",
      keyVersion: active.version,
      nonceBase64: Buffer.from(nonce).toString("base64"),
      ciphertextBase64: Buffer.from(sealed.ciphertext).toString("base64"),
      tagBase64: Buffer.from(sealed.tag).toString("base64"),
    };
  }

  open(envelope: DeliveryEnvelope, context: DeliveryAadContext): Uint8Array {
    try {
      if (envelope.schemaVersion !== 1 || envelope.algorithm !== "A256GCM") throw new Error("unsupported envelope");
      const key = this.keyring.readable(brandReference<string, "VaultKeyVersion">(envelope.keyVersion));
      return openAes256Gcm(
        key.key,
        Buffer.from(envelope.nonceBase64, "base64"),
        Buffer.from(envelope.ciphertextBase64, "base64"),
        Buffer.from(envelope.tagBase64, "base64"),
        encodeDeliveryAad(context),
      );
    } catch {
      throw new Error("delivery decryption unavailable");
    }
  }

  async rewrap(
    envelope: DeliveryEnvelope,
    context: DeliveryAadContext,
    replace: (candidate: DeliveryEnvelope) => Promise<void>,
  ): Promise<void> {
    const plaintext = this.open(envelope, context);
    try {
      const candidate = this.seal(plaintext, context);
      await replace(candidate);
    } finally {
      plaintext.fill(0);
    }
  }
}

/** Typed facade: channel endpoints are always sealed under the channel_endpoint AAD kind. */
export class ChannelEndpointVault {
  constructor(private readonly vault: DeliveryVault) {}

  #context(purpose: string, subject: string, endpoint: DeliveryEndpointReference): DeliveryAadContext {
    return { kind: "channel_endpoint", purpose, subject, reference: endpoint };
  }

  seal(plaintext: Uint8Array, ref: { purpose: string; subject: string; endpoint: DeliveryEndpointReference }): DeliveryEnvelope {
    return this.vault.seal(plaintext, this.#context(ref.purpose, ref.subject, ref.endpoint));
  }

  open(envelope: DeliveryEnvelope, ref: { purpose: string; subject: string; endpoint: DeliveryEndpointReference }): Uint8Array {
    return this.vault.open(envelope, this.#context(ref.purpose, ref.subject, ref.endpoint));
  }

  rewrap(
    envelope: DeliveryEnvelope,
    ref: { purpose: string; subject: string; endpoint: DeliveryEndpointReference },
    replace: (candidate: DeliveryEnvelope) => Promise<void>,
  ): Promise<void> {
    return this.vault.rewrap(envelope, this.#context(ref.purpose, ref.subject, ref.endpoint), replace);
  }
}

/** Typed facade: action materials are always sealed under the action_material AAD kind. */
export class DeliveryActionMaterialVault {
  constructor(private readonly vault: DeliveryVault) {}

  #context(purpose: string, subject: string, material: DeliveryActionMaterialReference): DeliveryAadContext {
    return { kind: "action_material", purpose, subject, reference: material };
  }

  seal(plaintext: Uint8Array, ref: { purpose: string; subject: string; material: DeliveryActionMaterialReference }): DeliveryEnvelope {
    return this.vault.seal(plaintext, this.#context(ref.purpose, ref.subject, ref.material));
  }

  open(envelope: DeliveryEnvelope, ref: { purpose: string; subject: string; material: DeliveryActionMaterialReference }): Uint8Array {
    return this.vault.open(envelope, this.#context(ref.purpose, ref.subject, ref.material));
  }

  rewrap(
    envelope: DeliveryEnvelope,
    ref: { purpose: string; subject: string; material: DeliveryActionMaterialReference },
    replace: (candidate: DeliveryEnvelope) => Promise<void>,
  ): Promise<void> {
    return this.vault.rewrap(envelope, this.#context(ref.purpose, ref.subject, ref.material), replace);
  }
}
