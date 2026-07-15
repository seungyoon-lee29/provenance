import { describe, expect, it, vi } from "vitest";

import type { ProviderConnectionReference, VaultKeyVersion, WorkspaceReference } from "../src/shared";
import { brandReference } from "../src/shared/contracts/brands";
import {
  CredentialKeyring,
  CredentialVault,
  openAes256Gcm,
  sealAes256Gcm,
  type CredentialAadContext,
  type CredentialEnvelope,
  type VaultKey,
} from "../src/platform/credential-vault";

function version(value: string): VaultKeyVersion {
  return brandReference<string, "VaultKeyVersion">(value);
}

function key(value: number, keyVersion: string, status: "active" | "previous", notAfter?: Date): VaultKey {
  return { version: version(keyVersion), key: Buffer.alloc(32, value), status, ...(notAfter === undefined ? {} : { notAfter }) };
}

function context(overrides: Partial<CredentialAadContext> = {}): CredentialAadContext {
  return {
    purpose: "provider_credential",
    workspaceReference: brandReference<string, "WorkspaceReference">("workspace-1") as WorkspaceReference,
    providerConnectionReference: brandReference<string, "ProviderConnectionReference">("connection-1") as ProviderConnectionReference,
    provider: "alpaca",
    credentialType: "paper-api-key",
    environment: "paper",
    ...overrides,
  };
}

function tamper(value: string): string {
  const bytes = Buffer.from(value, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString("base64");
}

describe("AES-256-GCM primitive", () => {
  it("matches the official NIST CAVP Count 0 vector", () => {
    const result = sealAes256Gcm(
      Buffer.from("92e11dcdaa866f5ce790fd24501f92509aacf4cb8b1339d50c9c1240935dd08b", "hex"),
      Buffer.from("ac93a1a6145299bde902f21a", "hex"),
      Buffer.from("2d71bcfa914e4ac045b2aa60955fad24", "hex"),
      Buffer.from("1e0889016f67601c8ebea4943bc23ad6", "hex"),
    );
    expect(Buffer.from(result.ciphertext).toString("hex")).toBe("8995ae2e6df3dbf96fac7b7137bae67f");
    expect(Buffer.from(result.tag).toString("hex")).toBe("eca5aa77d51d4a0a14d9c51e1da474ab");
    expect(Buffer.from(openAes256Gcm(
      Buffer.from("92e11dcdaa866f5ce790fd24501f92509aacf4cb8b1339d50c9c1240935dd08b", "hex"),
      Buffer.from("ac93a1a6145299bde902f21a", "hex"),
      result.ciphertext,
      result.tag,
      Buffer.from("1e0889016f67601c8ebea4943bc23ad6", "hex"),
    )).toString("hex")).toBe("2d71bcfa914e4ac045b2aa60955fad24");
  });
});

describe("CredentialVault", () => {
  it("owns immutable copies of key material", () => {
    const material = Buffer.alloc(32, 4);
    const keyring = new CredentialKeyring([{ version: version("v1"), key: material, status: "active" }]);
    material.fill(9);
    const firstRead = keyring.active();
    expect(firstRead.key[0]).toBe(4);
    firstRead.key[0] = 8;
    expect(keyring.active().key[0]).toBe(4);
  });

  it("round trips without storing plaintext in the envelope", () => {
    const vault = new CredentialVault(new CredentialKeyring([key(1, "v1", "active")]));
    const secret = Buffer.from("provider-secret-sentinel");
    const envelope = vault.seal(secret, context());
    expect(JSON.stringify(envelope)).not.toContain(secret.toString());
    expect(Buffer.from(vault.open(envelope, context())).toString()).toBe(secret.toString());
  });

  it.each(["ciphertextBase64", "tagBase64"] as const)("rejects tampered %s without leaking plaintext", (field) => {
    const vault = new CredentialVault(new CredentialKeyring([key(1, "v1", "active")]));
    const envelope = vault.seal(Buffer.from("provider-secret-sentinel"), context());
    const changed: CredentialEnvelope = { ...envelope, [field]: tamper(envelope[field]) };
    expect(() => vault.open(changed, context())).toThrow("credential decryption unavailable");
    try {
      vault.open(changed, context());
    } catch (error) {
      expect(String(error)).not.toContain("provider-secret-sentinel");
    }
  });

  it.each([
    ["workspace", { workspaceReference: brandReference<string, "WorkspaceReference">("workspace-2") as WorkspaceReference }],
    ["connection", { providerConnectionReference: brandReference<string, "ProviderConnectionReference">("connection-2") as ProviderConnectionReference }],
    ["provider", { provider: "kis" }],
    ["credential type", { credentialType: "live-api-key" }],
    ["environment", { environment: "live" as const }],
  ])("rejects an AAD %s swap", (_label, override) => {
    const vault = new CredentialVault(new CredentialKeyring([key(1, "v1", "active")]));
    const envelope = vault.seal(Buffer.from("secret"), context());
    expect(() => vault.open(envelope, context(override))).toThrow("credential decryption unavailable");
  });

  it("fails closed on a nonce collision", () => {
    const vault = new CredentialVault(new CredentialKeyring([key(1, "v1", "active")]), () => Buffer.alloc(12, 9));
    vault.seal(Buffer.from("first"), context());
    expect(() => vault.seal(Buffer.from("second"), context())).toThrow("credential encryption unavailable");
  });

  it("writes with active, reads unexpired previous, and rewraps transactionally", async () => {
    const oldVault = new CredentialVault(new CredentialKeyring([key(1, "v1", "active")]));
    const oldEnvelope = oldVault.seal(Buffer.from("rotating-secret"), context());
    const rotatingVault = new CredentialVault(new CredentialKeyring([
      key(2, "v2", "active"),
      key(1, "v1", "previous", new Date("2030-01-01T00:00:00.000Z")),
    ], () => new Date("2029-01-01T00:00:00.000Z")));
    const newEnvelope = rotatingVault.seal(Buffer.from("new-secret"), context());
    expect(newEnvelope.keyVersion).toBe("v2");
    expect(Buffer.from(rotatingVault.open(oldEnvelope, context())).toString()).toBe("rotating-secret");

    let replacement: CredentialEnvelope | undefined;
    await rotatingVault.rewrap(oldEnvelope, context(), async (candidate) => { replacement = candidate; });
    expect(replacement?.keyVersion).toBe("v2");
    if (replacement === undefined) throw new Error("rewrap did not produce a candidate");
    expect(Buffer.from(rotatingVault.open(replacement, context())).toString()).toBe("rotating-secret");

    const persistFailure = vi.fn(async () => { throw new Error("transaction rolled back"); });
    await expect(rotatingVault.rewrap(oldEnvelope, context(), persistFailure)).rejects.toThrow("transaction rolled back");
    expect(Buffer.from(rotatingVault.open(oldEnvelope, context())).toString()).toBe("rotating-secret");
  });

  it("rejects expired and unknown key versions", () => {
    const oldVault = new CredentialVault(new CredentialKeyring([key(1, "v1", "active")]));
    const oldEnvelope = oldVault.seal(Buffer.from("secret"), context());
    const current = new CredentialVault(new CredentialKeyring([
      key(2, "v2", "active"),
      key(1, "v1", "previous", new Date("2028-01-01T00:00:00.000Z")),
    ], () => new Date("2029-01-01T00:00:00.000Z")));
    expect(() => current.open(oldEnvelope, context())).toThrow("credential decryption unavailable");
    expect(() => current.open({ ...oldEnvelope, keyVersion: version("unknown") }, context())).toThrow("credential decryption unavailable");
  });
});
