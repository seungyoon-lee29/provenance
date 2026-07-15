import { createCipheriv, createDecipheriv } from "node:crypto";

export type SealedAesGcm = Readonly<{ ciphertext: Uint8Array; tag: Uint8Array }>;

export function sealAes256Gcm(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): SealedAesGcm {
  if (key.byteLength !== 32) throw new Error("AES-256-GCM requires a 32-byte key");
  if (nonce.byteLength !== 12) throw new Error("AES-256-GCM requires a 12-byte nonce");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

export function openAes256Gcm(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array, aad: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) throw new Error("AES-256-GCM requires a 32-byte key");
  if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw new Error("invalid AES-256-GCM envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
