import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { brandReference } from "../../shared/contracts/brands";
import { CredentialKeyring } from "./keyring";
import type { VaultKey } from "./types";

const localKeySchema = z.strictObject({
  kekBase64: z.string().min(1),
  status: z.enum(["active", "previous"]),
  notAfter: z.string().datetime().optional(),
});

const localKeyringSchema = z.strictObject({
  schemaVersion: z.literal(1),
  activeVersion: z.string().min(1),
  keys: z.record(z.string().min(1), localKeySchema),
});

function decodeKey(value: string): Uint8Array {
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) throw new Error("local credential keyring contains an invalid key");
  return decoded;
}

export function loadLocalCredentialKeyring(
  filePath: string,
  now: () => Date = () => new Date(),
  secretRootPath: string = path.resolve(process.cwd(), ".secrets"),
): CredentialKeyring {
  const requested = path.resolve(filePath);
  const requestedMetadata = lstatSync(requested);
  const secretRootMetadata = lstatSync(secretRootPath);
  if (requestedMetadata.isSymbolicLink() || secretRootMetadata.isSymbolicLink()) {
    throw new Error("local credential keyring cannot use symlinks");
  }
  const secretRoot = realpathSync(secretRootPath);
  const resolved = realpathSync(requested);
  const relative = path.relative(secretRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("local credential keyring must be inside .secrets");
  const ownerMismatch = typeof process.getuid === "function" && requestedMetadata.uid !== process.getuid();
  if (!requestedMetadata.isFile() || ownerMismatch || (requestedMetadata.mode & 0o777) !== 0o600 || requestedMetadata.size > 65_536) {
    throw new Error("local credential keyring must be an owner-only regular file no larger than 64 KiB");
  }
  const parsed = localKeyringSchema.parse(JSON.parse(readFileSync(resolved, "utf8")) as unknown);
  const keys: VaultKey[] = Object.entries(parsed.keys).map(([version, entry]) => ({
    version: brandReference<string, "VaultKeyVersion">(version),
    status: entry.status,
    key: decodeKey(entry.kekBase64),
    ...(entry.notAfter === undefined ? {} : { notAfter: new Date(entry.notAfter) }),
  }));
  const activeVersion = brandReference<string, "VaultKeyVersion">(parsed.activeVersion);
  if (!keys.some((key) => key.version === activeVersion && key.status === "active")) {
    throw new Error("local credential keyring activeVersion does not identify the active key");
  }
  return new CredentialKeyring(keys, now);
}
