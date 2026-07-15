/**
 * F5 Delivery Vault — blind acceptance (refutation) gate
 *
 * Derived exclusively from spec §12 / SEC-03 / AT-11 and the public API.
 * MUST NOT import from delivery-vault.ts, delivery-aad.ts, or delivery/index internals.
 */
import { describe, expect, it, vi } from "vitest";

import type { VaultKeyVersion } from "../src/shared/contracts/brands";
import { brandReference } from "../src/shared/contracts/brands";
import {
  ChannelEndpointVault,
  DeliveryActionMaterialVault,
  DeliveryKeyring,
  DeliveryVault,
  type DeliveryActionMaterialReference,
  type DeliveryAadContext,
  type DeliveryEndpointReference,
  type DeliveryEnvelope,
  type VaultKey,
} from "../src/platform/delivery";

// ── helpers ──────────────────────────────────────────────────────────────────

function ver(v: string): VaultKeyVersion {
  return brandReference<string, "VaultKeyVersion">(v);
}

function key(
  fill: number,
  version: string,
  status: "active" | "previous",
  notAfter?: Date,
): VaultKey {
  return {
    version: ver(version),
    key: Buffer.alloc(32, fill),
    status,
    ...(notAfter === undefined ? {} : { notAfter }),
  };
}

function ep(value: string): DeliveryEndpointReference {
  return brandReference<string, "DeliveryEndpointReference">(value);
}

function am(value: string): DeliveryActionMaterialReference {
  return brandReference<string, "DeliveryActionMaterialReference">(value);
}

function tamper(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  buf[0] = (buf[0] ?? 0) ^ 0xff;
  return buf.toString("base64");
}

const baseContext: DeliveryAadContext = {
  kind: "channel_endpoint",
  purpose: "email-verification",
  subject: "user-001",
  reference: "ref-001",
};

const SENTINEL = "user@example.com";

// ── 1. Round-trip ─────────────────────────────────────────────────────────────

describe("round-trip", () => {
  it("DeliveryVault seals and opens to identical bytes", () => {
    const vault = new DeliveryVault(new DeliveryKeyring([key(1, "v1", "active")]));
    const plain = Buffer.from(SENTINEL);
    const env = vault.seal(plain, baseContext);
    expect(Buffer.from(vault.open(env, baseContext))).toEqual(plain);
  });

  it("ChannelEndpointVault seals and opens to identical bytes", () => {
    const inner = new DeliveryVault(new DeliveryKeyring([key(2, "v1", "active")]));
    const facade = new ChannelEndpointVault(inner);
    const ref = { purpose: "push-notify", subject: "user-002", endpoint: ep("endpoint-abc") };
    const plain = Buffer.from("push-subscription-json");
    const env = facade.seal(plain, ref);
    expect(Buffer.from(facade.open(env, ref))).toEqual(plain);
  });

  it("DeliveryActionMaterialVault seals and opens to identical bytes", () => {
    const inner = new DeliveryVault(new DeliveryKeyring([key(3, "v1", "active")]));
    const facade = new DeliveryActionMaterialVault(inner);
    const ref = { purpose: "unsubscribe", subject: "user-003", material: am("material-xyz") };
    const plain = Buffer.from("unsubscribe-token");
    const env = facade.seal(plain, ref);
    expect(Buffer.from(facade.open(env, ref))).toEqual(plain);
  });
});

// ── 2. Sentinel redaction (SEC-05) ───────────────────────────────────────────

describe("sentinel redaction", () => {
  it("envelope JSON does not contain the plaintext sentinel", () => {
    const vault = new DeliveryVault(new DeliveryKeyring([key(1, "v1", "active")]));
    const env = vault.seal(Buffer.from(SENTINEL), baseContext);
    expect(JSON.stringify(env)).not.toContain(SENTINEL);
  });

  it("envelope JSON does not contain base64 of the sentinel", () => {
    const vault = new DeliveryVault(new DeliveryKeyring([key(1, "v1", "active")]));
    const b64Sentinel = Buffer.from(SENTINEL).toString("base64");
    const env = vault.seal(Buffer.from(SENTINEL), baseContext);
    expect(JSON.stringify(env)).not.toContain(b64Sentinel);
  });

  it("ChannelEndpointVault envelope does not contain sentinel", () => {
    const inner = new DeliveryVault(new DeliveryKeyring([key(2, "v1", "active")]));
    const facade = new ChannelEndpointVault(inner);
    const ref = { purpose: "email-link", subject: "sub-1", endpoint: ep("ep-1") };
    const env = facade.seal(Buffer.from(SENTINEL), ref);
    expect(JSON.stringify(env)).not.toContain(SENTINEL);
  });
});

// ── 3. Tamper detection ───────────────────────────────────────────────────────

describe("tamper detection", () => {
  it.each(["ciphertextBase64", "tagBase64", "nonceBase64"] as const)(
    "rejects tampered %s with 'delivery decryption unavailable'",
    (field) => {
      const vault = new DeliveryVault(new DeliveryKeyring([key(1, "v1", "active")]));
      const env = vault.seal(Buffer.from(SENTINEL), baseContext);
      const bad: DeliveryEnvelope = { ...env, [field]: tamper(env[field]) };
      expect(() => vault.open(bad, baseContext)).toThrow("delivery decryption unavailable");
    },
  );

  it.each(["ciphertextBase64", "tagBase64", "nonceBase64"] as const)(
    "tampered %s error does not leak sentinel",
    (field) => {
      const vault = new DeliveryVault(new DeliveryKeyring([key(1, "v1", "active")]));
      const env = vault.seal(Buffer.from(SENTINEL), baseContext);
      const bad: DeliveryEnvelope = { ...env, [field]: tamper(env[field]) };
      try {
        vault.open(bad, baseContext);
      } catch (e) {
        expect(String(e)).not.toContain(SENTINEL);
      }
    },
  );
});

// ── 4. AAD binding ────────────────────────────────────────────────────────────

describe("AAD binding", () => {
  const vault = new DeliveryVault(new DeliveryKeyring([key(1, "v1", "active")]));
  const plain = Buffer.from("secret-payload");

  it.each([
    ["purpose", { ...baseContext, purpose: "different-purpose" }],
    ["subject", { ...baseContext, subject: "different-subject" }],
    ["reference", { ...baseContext, reference: "different-ref" }],
  ] as const)("rejects AAD swap on %s", (_label, badCtx) => {
    const env = vault.seal(plain, baseContext);
    expect(() => vault.open(env, badCtx)).toThrow("delivery decryption unavailable");
  });

  it("rejects kind swap from channel_endpoint to action_material (domain confusion)", () => {
    // Same purpose/subject/reference — only the kind differs.
    // The kind MUST be independently bound in the AAD.
    // If this does NOT throw, the implementation has a real domain-confusion weakness.
    const sharedRef = "shared-ref-value";
    const epCtx: DeliveryAadContext = {
      kind: "channel_endpoint",
      purpose: "notify",
      subject: "u1",
      reference: sharedRef,
    };
    const amCtx: DeliveryAadContext = {
      kind: "action_material",
      purpose: "notify",
      subject: "u1",
      reference: sharedRef,
    };
    const env = vault.seal(plain, epCtx);
    expect(() => vault.open(env, amCtx)).toThrow("delivery decryption unavailable");
  });

  it("ChannelEndpointVault envelope is rejected by DeliveryActionMaterialVault (typed facade kind isolation)", () => {
    // Brand the same string as both reference types so purpose/subject/reference all match.
    const sharedString = "shared-value";
    const sharedEp = brandReference<string, "DeliveryEndpointReference">(sharedString);
    const sharedAm = brandReference<string, "DeliveryActionMaterialReference">(sharedString);

    const inner = new DeliveryVault(new DeliveryKeyring([key(4, "v1", "active")]));
    const epVault = new ChannelEndpointVault(inner);
    const amVault = new DeliveryActionMaterialVault(inner);

    const epRef = { purpose: "p", subject: "s", endpoint: sharedEp };
    const amRef = { purpose: "p", subject: "s", material: sharedAm };

    const env = epVault.seal(plain, epRef);
    // The facades fix kind in the AAD; crossing them must fail.
    expect(() => amVault.open(env, amRef)).toThrow("delivery decryption unavailable");
  });
});

// ── 5. Nonce collision ────────────────────────────────────────────────────────

describe("nonce collision", () => {
  it("fails closed on the second seal when the nonce source is constant", () => {
    const constantNonce = (): Uint8Array => Buffer.alloc(12, 7);
    const vault = new DeliveryVault(
      new DeliveryKeyring([key(1, "v1", "active")]),
      constantNonce,
    );
    vault.seal(Buffer.from("first"), baseContext);
    expect(() => vault.seal(Buffer.from("second"), baseContext)).toThrow(
      "delivery encryption unavailable",
    );
  });
});

// ── 6. Rotation and rewrap ────────────────────────────────────────────────────

describe("rotation and rewrap", () => {
  const plain = Buffer.from("rotating-secret");

  it("new seals use the active key after rotation", () => {
    const oldVault = new DeliveryVault(new DeliveryKeyring([key(1, "v1", "active")]));
    const rotatedVault = new DeliveryVault(
      new DeliveryKeyring(
        [
          key(2, "v2", "active"),
          key(1, "v1", "previous", new Date("2030-01-01T00:00:00.000Z")),
        ],
        () => new Date("2029-01-01T00:00:00.000Z"),
      ),
    );

    const oldEnv = oldVault.seal(plain, baseContext);
    const newEnv = rotatedVault.seal(plain, baseContext);
    expect(newEnv.keyVersion).toBe("v2");
    expect(oldEnv.keyVersion).toBe("v1");
  });

  it("unexpired previous key can still decrypt old envelopes", () => {
    const oldVault = new DeliveryVault(new DeliveryKeyring([key(1, "v1", "active")]));
    const oldEnv = oldVault.seal(plain, baseContext);

    const rotatedVault = new DeliveryVault(
      new DeliveryKeyring(
        [
          key(2, "v2", "active"),
          key(1, "v1", "previous", new Date("2030-01-01T00:00:00.000Z")),
        ],
        () => new Date("2029-01-01T00:00:00.000Z"),
      ),
    );
    expect(Buffer.from(rotatedVault.open(oldEnv, baseContext))).toEqual(plain);
  });

  it("rewrap produces a v2 candidate that decrypts to original plaintext", async () => {
    const oldVault = new DeliveryVault(new DeliveryKeyring([key(1, "v1", "active")]));
    const oldEnv = oldVault.seal(plain, baseContext);

    const rotatedVault = new DeliveryVault(
      new DeliveryKeyring(
        [
          key(2, "v2", "active"),
          key(1, "v1", "previous", new Date("2030-01-01T00:00:00.000Z")),
        ],
        () => new Date("2029-01-01T00:00:00.000Z"),
      ),
    );

    let candidate: DeliveryEnvelope | undefined;
    await rotatedVault.rewrap(oldEnv, baseContext, async (c) => {
      candidate = c;
    });

    expect(candidate).toBeDefined();
    expect(candidate?.keyVersion).toBe("v2");
    expect(Buffer.from(rotatedVault.open(candidate!, baseContext))).toEqual(plain);
  });

  it("rewrap is transactional: replace callback throwing leaves original openable", async () => {
    const oldVault = new DeliveryVault(new DeliveryKeyring([key(1, "v1", "active")]));
    const oldEnv = oldVault.seal(plain, baseContext);

    const rotatedVault = new DeliveryVault(
      new DeliveryKeyring(
        [
          key(2, "v2", "active"),
          key(1, "v1", "previous", new Date("2030-01-01T00:00:00.000Z")),
        ],
        () => new Date("2029-01-01T00:00:00.000Z"),
      ),
    );

    const failingReplace = vi.fn(async () => {
      throw new Error("db rolled back");
    });
    await expect(
      rotatedVault.rewrap(oldEnv, baseContext, failingReplace),
    ).rejects.toThrow("db rolled back");

    // Original must survive the failed rewrap.
    expect(Buffer.from(rotatedVault.open(oldEnv, baseContext))).toEqual(plain);
  });
});

// ── 7. Fail closed after expiry / unknown version ─────────────────────────────

describe("fail closed after expiry or unknown key version", () => {
  it("rejects an expired previous key (notAfter in the past)", () => {
    const oldVault = new DeliveryVault(new DeliveryKeyring([key(1, "v1", "active")]));
    const oldEnv = oldVault.seal(Buffer.from("secret"), baseContext);

    // now() is AFTER notAfter → key is expired
    const expiredVault = new DeliveryVault(
      new DeliveryKeyring(
        [
          key(2, "v2", "active"),
          key(1, "v1", "previous", new Date("2020-01-01T00:00:00.000Z")),
        ],
        () => new Date("2025-01-01T00:00:00.000Z"),
      ),
    );
    expect(() => expiredVault.open(oldEnv, baseContext)).toThrow(
      "delivery decryption unavailable",
    );
  });

  it("rejects an unknown keyVersion", () => {
    const vault = new DeliveryVault(new DeliveryKeyring([key(1, "v1", "active")]));
    const env = vault.seal(Buffer.from("secret"), baseContext);
    const unknownVersionEnv: DeliveryEnvelope = { ...env, keyVersion: ver("unknown-ver") };
    expect(() => vault.open(unknownVersionEnv, baseContext)).toThrow(
      "delivery decryption unavailable",
    );
  });
});

// ── 8. Misconfiguration / no plaintext fallback ───────────────────────────────

describe("misconfiguration: no plaintext fallback", () => {
  it("throws when keyring is constructed with zero keys", () => {
    expect(() => new DeliveryKeyring([])).toThrow();
  });

  it("throws when keyring has only a 'previous' key (no active key)", () => {
    expect(() =>
      new DeliveryKeyring([key(1, "v1", "previous", new Date("2030-01-01T00:00:00.000Z"))]),
    ).toThrow();
  });

  it("throws when a key is shorter than 32 bytes", () => {
    expect(() =>
      new DeliveryKeyring([
        {
          version: ver("v1"),
          key: Buffer.alloc(16, 1), // 128-bit, not 256-bit
          status: "active",
        },
      ]),
    ).toThrow();
  });

  it("throws when a key is longer than 32 bytes", () => {
    expect(() =>
      new DeliveryKeyring([
        {
          version: ver("v1"),
          key: Buffer.alloc(64, 1), // too long
          status: "active",
        },
      ]),
    ).toThrow();
  });
});
