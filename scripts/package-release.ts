import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { classifyReleaseFiles, scanSecrets } from "./release/manifest";

/**
 * F11 release packager (spec §13.2, AC): builds a secret-free release ZIP of the
 * tracked deliverable plus a SHA-256 manifest. Fails closed if any tracked file
 * can't be categorized, if a credential pattern is found, or if a forbidden path
 * slipped through. The unpack→documented-command→healthcheck drill needs Docker
 * and is recorded as a ready-for-human gate (see docs/release.md).
 */

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_OUT_DIR = resolve(ROOT, "dist/release");
export const RELEASE_ZIP_NAME = "fakebloomberg-release.zip";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

export type ReleaseManifest = Readonly<{
  generatedFromCommit: string;
  fileCount: number;
  totalBytes: number;
  aggregateSha256: string;
  categories: Readonly<Record<string, number>>;
  excludedCount: number;
  files: readonly Readonly<{ path: string; category: string; sha256: string; bytes: number }>[];
}>;

export function buildManifest(): ReleaseManifest {
  const tracked = git("ls-files").split("\n").filter((line) => line.length > 0);
  const { included, uncategorized } = classifyReleaseFiles(tracked);
  if (uncategorized.length > 0) {
    throw new Error(`release: ${uncategorized.length} tracked file(s) fit no allowed category (fail closed): ${uncategorized.slice(0, 5).join(", ")}`);
  }

  const files = included
    .map(({ path, category }) => {
      const content = readFileSync(resolve(ROOT, path));
      // Credential formats are text; skip binary blobs (a NUL byte) to avoid false positives.
      if (!content.includes(0)) {
        const leaked = scanSecrets(content.toString("utf8"));
        if (leaked.length > 0) throw new Error(`release: credential pattern in ${path} (${leaked.join(", ")})`);
      }
      return { path, category, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.byteLength };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const aggregateSha256 = createHash("sha256").update(files.map((file) => `${file.sha256}  ${file.path}`).join("\n")).digest("hex");
  const categories: Record<string, number> = {};
  for (const file of files) categories[file.category] = (categories[file.category] ?? 0) + 1;

  return {
    generatedFromCommit: git("rev-parse", "HEAD"),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    aggregateSha256,
    categories,
    excludedCount: tracked.length - files.length,
    files,
  };
}

/** Write the manifest + secret-free zip to `outDir`; returns the manifest and zip path. */
export function writeRelease(outDir: string = DEFAULT_OUT_DIR): Readonly<{ manifest: ReleaseManifest; manifestPath: string; zipPath: string }> {
  const manifest = buildManifest();
  const manifestPath = resolve(outDir, "manifest.json");
  const zipPath = resolve(outDir, RELEASE_ZIP_NAME);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // Deterministic zip of exactly the manifest files, streamed from stdin (-@).
  rmSync(zipPath, { force: true });
  execFileSync("zip", ["-X", "-@", zipPath], { cwd: ROOT, input: manifest.files.map((file) => file.path).join("\n"), stdio: ["pipe", "ignore", "inherit"] });
  return { manifest, manifestPath, zipPath };
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  const { manifest, manifestPath, zipPath } = writeRelease();
  process.stdout.write(`release: ${manifest.fileCount} files, ${(manifest.totalBytes / 1024).toFixed(0)} KiB, ${manifest.excludedCount} excluded\n`);
  process.stdout.write(`release: manifest ${manifestPath}\nrelease: zip ${zipPath}\nrelease: aggregate ${manifest.aggregateSha256}\n`);
  process.stdout.write(`release: categories ${JSON.stringify(manifest.categories)}\n`);
}
