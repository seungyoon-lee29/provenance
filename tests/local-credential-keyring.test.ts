import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalCredentialKeyring } from "../src/platform/credential-vault";

const roots: string[] = [];

function fixture(extra: Readonly<Record<string, unknown>> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "provenance-keyring-"));
  roots.push(root);
  const secretRoot = path.join(root, ".secrets");
  mkdirSync(secretRoot, { mode: 0o700 });
  const filePath = path.join(secretRoot, "credential-keyring.json");
  writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    activeVersion: "v1",
    keys: {
      v1: { kekBase64: Buffer.alloc(32, 7).toString("base64"), status: "active" },
    },
    ...extra,
  }), { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return { root, secretRoot, filePath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local credential keyring", () => {
  it("loads one owner-only active AES-256 key inside .secrets", () => {
    const files = fixture();
    const keyring = loadLocalCredentialKeyring(files.filePath, () => new Date("2029-01-01T00:00:00.000Z"), files.secretRoot);
    expect(keyring.active().version).toBe("v1");
    expect(keyring.active().key).toHaveLength(32);
  });

  it("rejects permissive mode, symlink, and a file outside .secrets", () => {
    const files = fixture();
    chmodSync(files.filePath, 0o644);
    expect(() => loadLocalCredentialKeyring(files.filePath, undefined, files.secretRoot)).toThrow("owner-only");
    chmodSync(files.filePath, 0o600);
    const linkPath = path.join(files.secretRoot, "link.json");
    symlinkSync(files.filePath, linkPath);
    expect(() => loadLocalCredentialKeyring(linkPath, undefined, files.secretRoot)).toThrow("symlinks");
    const outside = path.join(files.root, "outside.json");
    writeFileSync(outside, "{}", { mode: 0o600 });
    chmodSync(outside, 0o600);
    expect(() => loadLocalCredentialKeyring(outside, undefined, files.secretRoot)).toThrow("inside .secrets");
  });

  it("rejects unknown fields and an invalid active key", () => {
    const unknown = fixture({ unexpected: true });
    expect(() => loadLocalCredentialKeyring(unknown.filePath, undefined, unknown.secretRoot)).toThrow();
    const invalid = fixture({
      keys: { v1: { kekBase64: Buffer.alloc(16, 7).toString("base64"), status: "active" } },
    });
    expect(() => loadLocalCredentialKeyring(invalid.filePath, undefined, invalid.secretRoot)).toThrow("invalid key");
  });
});
