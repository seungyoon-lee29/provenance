import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalDeliveryKeyring } from "../src/composition";

const roots: string[] = [];

function writeKeyring(value: unknown): { file: string; root: string } {
  const parent = mkdtempSync(path.join(tmpdir(), "fakebloomberg-delivery-"));
  roots.push(parent);
  const root = path.join(parent, ".secrets");
  mkdirSync(root, { mode: 0o700 });
  const file = path.join(root, "delivery-keyring.json");
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, root };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local delivery keyring", () => {
  it("loads one active Resend version with its required secrets", () => {
    const { file, root } = writeKeyring({
      schemaVersion: 1,
      activeVersion: "delivery-v2",
      keys: {
        "delivery-v1": { status: "previous", notAfter: "2030-01-01T00:00:00.000Z", secrets: {} },
        "delivery-v2": { status: "active", secrets: { resendApiKey: "sentinel", resendWebhookSigningSecret: "sentinel" } },
      },
    });
    expect(loadLocalDeliveryKeyring(file, "resend", () => new Date("2029-01-01T00:00:00.000Z"), root).activeVersion).toBe("delivery-v2");
  });

  it("rejects incomplete Resend material and permissive file modes", () => {
    const incomplete = writeKeyring({
      schemaVersion: 1,
      activeVersion: "delivery-v1",
      keys: { "delivery-v1": { status: "active", secrets: { resendApiKey: "sentinel" } } },
    });
    expect(() => loadLocalDeliveryKeyring(incomplete.file, "resend", undefined, incomplete.root)).toThrow("API and webhook");
    chmodSync(incomplete.file, 0o644);
    expect(() => loadLocalDeliveryKeyring(incomplete.file, "disabled", undefined, incomplete.root)).toThrow("owner-only");
  });
});
