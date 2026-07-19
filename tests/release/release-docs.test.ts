import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { checkReleaseDocs } from "../../scripts/check-release-docs";

const ROOT = resolve(import.meta.dirname, "../..");

/** The link check enumerates docs via `git ls-files`; skip in a container build with no git. */
function hasGit(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("F11 release docs", () => {
  it.skipIf(!hasGit())("has no broken Markdown links and no stale npm-run references", () => {
    const result = checkReleaseDocs();
    expect(result.brokenLinks).toEqual([]);
    expect(result.missingScripts).toEqual([]);
    expect(result.checkedDocs).toBeGreaterThan(0);
  });

  it("ships the six required release docs", () => {
    for (const doc of ["setup", "architecture", "rights", "privacy", "backup", "release"]) {
      expect(existsSync(resolve(ROOT, `docs/release/${doc}.md`))).toBe(true);
    }
  });
});
