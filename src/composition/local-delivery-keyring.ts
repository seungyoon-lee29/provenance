import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

const deliveryKeySchema = z.strictObject({
  status: z.enum(["active", "previous"]),
  notAfter: z.string().datetime().optional(),
  secrets: z.record(z.string().min(1), z.string().min(1)),
});

const deliveryKeyringSchema = z.strictObject({
  schemaVersion: z.literal(1),
  activeVersion: z.string().min(1),
  keys: z.record(z.string().min(1), deliveryKeySchema),
});

export type LocalDeliveryKeyring = z.infer<typeof deliveryKeyringSchema>;

export function loadLocalDeliveryKeyring(
  filePath: string,
  emailProvider: "disabled" | "mailpit" | "resend",
  now: () => Date = () => new Date(),
  secretRootPath: string = path.resolve(process.cwd(), ".secrets"),
): LocalDeliveryKeyring {
  const requested = path.resolve(filePath);
  const requestedMetadata = lstatSync(requested);
  const secretRootMetadata = lstatSync(secretRootPath);
  if (requestedMetadata.isSymbolicLink() || secretRootMetadata.isSymbolicLink()) {
    throw new Error("local delivery keyring cannot use symlinks");
  }
  const secretRoot = realpathSync(secretRootPath);
  const resolved = realpathSync(requested);
  const relative = path.relative(secretRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("local delivery keyring must be inside .secrets");
  const ownerMismatch = typeof process.getuid === "function" && requestedMetadata.uid !== process.getuid();
  if (!requestedMetadata.isFile() || ownerMismatch || (requestedMetadata.mode & 0o777) !== 0o600 || requestedMetadata.size > 65_536) {
    throw new Error("local delivery keyring must be an owner-only regular file no larger than 64 KiB");
  }
  const parsed = deliveryKeyringSchema.parse(JSON.parse(readFileSync(resolved, "utf8")) as unknown);
  const entries = Object.entries(parsed.keys);
  const activeEntries = entries.filter(([, entry]) => entry.status === "active");
  const active = parsed.keys[parsed.activeVersion];
  if (activeEntries.length !== 1 || active?.status !== "active") {
    throw new Error("local delivery keyring requires exactly one matching active version");
  }
  for (const [, entry] of entries) {
    if (entry.status === "previous" && entry.notAfter === undefined) throw new Error("previous delivery keys require an expiry");
    if (entry.notAfter !== undefined && new Date(entry.notAfter).getTime() <= now().getTime() && entry.status === "active") {
      throw new Error("local delivery keyring active version is expired");
    }
  }
  if (emailProvider === "resend" && (active.secrets.resendApiKey === undefined || active.secrets.resendWebhookSigningSecret === undefined)) {
    throw new Error("Resend requires active API and webhook signing secrets in the delivery keyring");
  }
  return parsed;
}
