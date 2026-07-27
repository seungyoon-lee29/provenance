import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * Do the release suites have the git worktree they read (`git ls-files`)?
 *
 * The container image has no `.git` — `.dockerignore` excludes it deliberately —
 * so these suites genuinely cannot run there. That part is fine. What was not
 * fine is HOW the absence was handled: three copies of a private `hasGit()`
 * probe turned "no git here" into a silent `describe.skipIf`, so the compose
 * `pr-check` lane ran `npm run check` and reported success while quietly
 * dropping every release suite. A lane that covers less than it appears to is
 * the same failure as a gate that cannot fail (2026-07-27, arch-2 group B).
 *
 * So the skip must be DECLARED. A lane that legitimately has no git says so
 * with `RELEASE_LANE_WITHOUT_GIT=1` (compose sets it on `pr-check`). Anywhere
 * else a missing worktree is a broken environment, and this throws rather than
 * silently shrinking the suite — a collection error is loud; a skip is not.
 */
export function releaseGitLane(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    if (process.env.RELEASE_LANE_WITHOUT_GIT === "1") return false;
    throw new Error(
      "release suites read the git worktree and this environment has none. "
      + "If that is expected — e.g. an image built with .git excluded — declare it "
      + "with RELEASE_LANE_WITHOUT_GIT=1 so the reduced coverage is visible, "
      + "instead of skipping silently.",
    );
  }
}
