import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { checkReleaseDocs } from "../../scripts/check-release-docs";
import { releaseGitLane } from "./git-lane";

const ROOT = resolve(import.meta.dirname, "../..");

describe("F11 release docs", () => {
  it.skipIf(!releaseGitLane())("has no broken Markdown links and no stale npm-run references", () => {
    const result = checkReleaseDocs();
    expect(result.brokenLinks).toEqual([]);
    expect(result.missingScripts).toEqual([]);
    expect(result.checkedDocs).toBeGreaterThan(0);
  });

  it("release.md's screenshot table matches the manifest entry for entry", () => {
    // Two catalogs of the same fact drifted: the manifest dropped the two
    // synthetic scenes when the routes they photographed were deleted, and the
    // prose table kept advertising four. Nothing caught it — the doc gate checks
    // links and script names, not claimed artifacts.
    const manifest = JSON.parse(readFileSync(resolve(ROOT, "tests/release/screenshot-manifest.json"), "utf8")) as
      Readonly<{ screenshots?: readonly Readonly<{ file: string }>[] }>;
    const entries = manifest.screenshots;
    // Named key, not a positional guess: reaching for "the first array-ish value"
    // silently picked up `purpose` and made this assertion fail on a correct
    // manifest, which is the failure mode where a guard gets deleted as flaky.
    if (entries === undefined) throw new Error("screenshot-manifest.json has no `screenshots` array");
    const declared = new Set(entries.map((entry) => entry.file.split("/").pop()!));

    const release = readFileSync(resolve(ROOT, "docs/release/release.md"), "utf8");
    const table = release.slice(release.indexOf("## Screenshots"));
    const listed = new Set([...table.matchAll(/^\| `(?<file>[\w-]+\.png)`/gmu)].map((m) => m.groups!.file!));

    expect([...listed].sort()).toEqual([...declared].sort());
  });

  it("ships the six required release docs", () => {
    for (const doc of ["setup", "architecture", "rights", "privacy", "backup", "release"]) {
      expect(existsSync(resolve(ROOT, `docs/release/${doc}.md`))).toBe(true);
    }
  });
});
