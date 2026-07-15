import { describe, expect, it, vi } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { VaultKeyVersion } from "../src/shared/contracts/brands";
import {
  ChannelEndpointVault,
  DeliveryActionMaterialVault,
  DeliveryKeyring,
  DeliveryVault,
  type DeliveryActionMaterialReference,
  type DeliveryEndpointReference,
  type DeliveryEnvelope,
  type VaultKey,
} from "../src/platform/delivery";

const SENTINEL = "DELIVERY-SECRET-SENTINEL-alice@example.com";

function version(v: string): VaultKeyVersion {
  return brandReference<string, "VaultKeyVersion">(v);
}
function key(fill: number, v: string, status: "active" | "previous", notAfter?: Date): VaultKey {
  return { version: version(v), key: Buffer.alloc(32, fill), status, ...(notAfter === undefined ? {} : { notAfter }) };
}
function vault(keys: readonly VaultKey[] = [key(1, "v1", "active")], now?: () => Date, nonce?: () => Uint8Array): DeliveryVault {
  return new DeliveryVault(new DeliveryKeyring(keys, now), nonce);
}
function tamper(value: string): string {
  const bytes = Buffer.from(value, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString("base64");
}

const endpoint = brandReference<string, "DeliveryEndpointReference">("endpoint:1") as DeliveryEndpointReference;
const material = brandReference<string, "DeliveryActionMaterialReference">("material:1") as DeliveryActionMaterialReference;
const endpointRef = { purpose: "workspace_financial_email", subject: "workspace:w1", endpoint };
const materialRef = { purpose: "account_challenge", subject: "workspace:w1", material };

describe("DeliveryVault — AES-256-GCM envelope, no plaintext fallback (SEC-03/AT-11)", () => {
  it("round trips through the channel endpoint vault without storing plaintext", () => {
    const v = new ChannelEndpointVault(vault());
    const envelope = v.seal(Buffer.from(SENTINEL), endpointRef);
    // sentinel redaction: the envelope must not contain the raw secret.
    expect(JSON.stringify(envelope)).not.toContain(SENTINEL);
    expect(JSON.stringify(envelope)).not.toContain("alice@example.com");
    expect(Buffer.from(v.open(envelope, endpointRef)).toString()).toBe(SENTINEL);
  });

  it.each(["ciphertextBase64", "tagBase64", "nonceBase64"] as const)("rejects a tampered %s without leaking plaintext", (field) => {
    const v = new ChannelEndpointVault(vault());
    const envelope = v.seal(Buffer.from(SENTINEL), endpointRef);
    const changed = { ...envelope, [field]: tamper(envelope[field]) } as DeliveryEnvelope;
    expect(() => v.open(changed, endpointRef)).toThrow("delivery decryption unavailable");
    try {
      v.open(changed, endpointRef);
    } catch (error) {
      expect(String(error)).not.toContain(SENTINEL);
    }
  });

  it.each([
    ["purpose", { ...endpointRef, purpose: "authenticated_security_notice" }],
    ["subject", { ...endpointRef, subject: "workspace:other" }],
    ["endpoint reference", { ...endpointRef, endpoint: brandReference<string, "DeliveryEndpointReference">("endpoint:2") as DeliveryEndpointReference }],
  ])("rejects an AAD %s swap", (_label, override) => {
    const v = new ChannelEndpointVault(vault());
    const envelope = v.seal(Buffer.from(SENTINEL), endpointRef);
    expect(() => v.open(envelope, override)).toThrow("delivery decryption unavailable");
  });

  it("keeps channel endpoints and action materials in separate AAD domains", () => {
    const shared = vault();
    const endpoints = new ChannelEndpointVault(shared);
    const materials = new DeliveryActionMaterialVault(shared);
    const sealedEndpoint = endpoints.seal(Buffer.from(SENTINEL), endpointRef);
    // Same keyring, same subject/purpose text — but the material vault uses the
    // action_material AAD kind, so it cannot open an endpoint envelope.
    expect(() =>
      materials.open(sealedEndpoint, { purpose: endpointRef.purpose, subject: endpointRef.subject, material }),
    ).toThrow("delivery decryption unavailable");
  });

  it("separates the two domains by AAD kind alone (identical purpose/subject/reference)", () => {
    const shared = vault();
    const endpoints = new ChannelEndpointVault(shared);
    const materials = new DeliveryActionMaterialVault(shared);
    // Same underlying reference string, purpose and subject — only the AAD kind
    // (channel_endpoint vs action_material) differs. Opening across kinds must fail.
    const collidingId = "delivery:shared-id";
    const asEndpoint = brandReference<string, "DeliveryEndpointReference">(collidingId) as DeliveryEndpointReference;
    const asMaterial = brandReference<string, "DeliveryActionMaterialReference">(collidingId) as DeliveryActionMaterialReference;
    const sealed = endpoints.seal(Buffer.from(SENTINEL), { purpose: "shared", subject: "workspace:w1", endpoint: asEndpoint });
    expect(() => materials.open(sealed, { purpose: "shared", subject: "workspace:w1", material: asMaterial })).toThrow(
      "delivery decryption unavailable",
    );
  });

  it("fails closed on a nonce collision", () => {
    const v = new ChannelEndpointVault(vault([key(1, "v1", "active")], undefined, () => Buffer.alloc(12, 9)));
    v.seal(Buffer.from("first"), endpointRef);
    expect(() => v.seal(Buffer.from("second"), endpointRef)).toThrow("delivery encryption unavailable");
  });

  it("writes with active, reads unexpired previous, and rewraps transactionally", async () => {
    const old = new ChannelEndpointVault(vault([key(1, "v1", "active")]));
    const oldEnvelope = old.seal(Buffer.from(SENTINEL), endpointRef);
    const rotating = new ChannelEndpointVault(
      vault([key(2, "v2", "active"), key(1, "v1", "previous", new Date("2030-01-01T00:00:00.000Z"))], () => new Date("2029-01-01T00:00:00.000Z")),
    );
    const fresh = rotating.seal(Buffer.from("new"), endpointRef);
    expect(fresh.keyVersion).toBe("v2");
    expect(Buffer.from(rotating.open(oldEnvelope, endpointRef)).toString()).toBe(SENTINEL);

    let replacement: DeliveryEnvelope | undefined;
    await rotating.rewrap(oldEnvelope, endpointRef, async (candidate) => { replacement = candidate; });
    expect(replacement?.keyVersion).toBe("v2");
    if (replacement === undefined) throw new Error("rewrap produced no candidate");
    expect(Buffer.from(rotating.open(replacement, endpointRef)).toString()).toBe(SENTINEL);

    const persistFailure = vi.fn(async () => { throw new Error("transaction rolled back"); });
    await expect(rotating.rewrap(oldEnvelope, endpointRef, persistFailure)).rejects.toThrow("transaction rolled back");
    expect(Buffer.from(rotating.open(oldEnvelope, endpointRef)).toString()).toBe(SENTINEL);
  });

  it("rejects expired and unknown key versions (fail closed after notAfter)", () => {
    const old = new ChannelEndpointVault(vault([key(1, "v1", "active")]));
    const oldEnvelope = old.seal(Buffer.from(SENTINEL), endpointRef);
    const current = new ChannelEndpointVault(
      vault([key(2, "v2", "active"), key(1, "v1", "previous", new Date("2028-01-01T00:00:00.000Z"))], () => new Date("2029-01-01T00:00:00.000Z")),
    );
    expect(() => current.open(oldEnvelope, endpointRef)).toThrow("delivery decryption unavailable");
    expect(() => current.open({ ...oldEnvelope, keyVersion: version("unknown") }, endpointRef)).toThrow("delivery decryption unavailable");
  });

  it("requires exactly one active KEK (no plaintext fallback when misconfigured)", () => {
    expect(() => new DeliveryKeyring([key(1, "v1", "previous", new Date("2030-01-01T00:00:00.000Z"))])).toThrow();
    expect(() => new DeliveryKeyring([])).toThrow();
  });

  it("round trips action materials under their own facade", () => {
    const v = new DeliveryActionMaterialVault(vault());
    const envelope = v.seal(Buffer.from(SENTINEL), materialRef);
    expect(JSON.stringify(envelope)).not.toContain(SENTINEL);
    expect(Buffer.from(v.open(envelope, materialRef)).toString()).toBe(SENTINEL);
  });
});
