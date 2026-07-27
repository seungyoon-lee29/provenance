import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { writeRelease } from "../../scripts/package-release";
import { releaseGitLane } from "./git-lane";

const work = mkdtempSync(join(tmpdir(), "fb-release-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [resolve(full).slice(resolve(base).length + 1)];
  });
}

describe.skipIf(!releaseGitLane())("F11 release zip round-trip", () => {
  it("unpacks to exactly the manifest — secret-free, no agent/vcs/env artifacts", () => {
    const { manifest, zipPath } = writeRelease(join(work, "out"));
    const unpacked = join(work, "unpacked");
    execFileSync("unzip", ["-q", zipPath, "-d", unpacked]);

    const onDisk = walk(unpacked).sort();
    const declared = manifest.files.map((file) => file.path).sort();
    expect(onDisk).toEqual(declared);

    for (const path of onDisk) {
      expect(path.startsWith(".scratch/")).toBe(false);
      expect(path.startsWith(".secrets/")).toBe(false);
      expect(path.startsWith(".git/")).toBe(false);
      expect(path === ".env.local").toBe(false);
    }

    // Content integrity: a sampled unpacked file hashes to its manifest entry.
    const sample = manifest.files.find((file) => file.path === "package.json");
    expect(sample).toBeDefined();
    const rehashed = createHash("sha256").update(readFileSync(join(unpacked, "package.json"))).digest("hex");
    expect(rehashed).toBe(sample?.sha256);
  });
});
