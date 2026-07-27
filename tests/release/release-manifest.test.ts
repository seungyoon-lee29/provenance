import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { classifyReleaseFiles, scanSecrets } from "../../scripts/release/manifest";
import { buildManifest } from "../../scripts/package-release";
import { releaseGitLane } from "./git-lane";

const ROOT = resolve(import.meta.dirname, "../..");
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter((line) => line.length > 0);
}

describe("F11 release allowlist classification", () => {
  it("excludes agent state, env secrets and the secret store; keeps the deliverable", () => {
    const { included, excluded, uncategorized } = classifyReleaseFiles([
      ".scratch/financial-terminal/map.md",
      ".env.local",
      ".env.example",
      ".secrets/credential-keyring.json",
      "src/app/page.tsx",
      "db/0001_init.sql",
      "package-lock.json",
      "Dockerfile",
      "docs/release.md",
    ]);
    const includedPaths = included.map((entry) => entry.path);
    expect(includedPaths).toEqual([".env.example", "src/app/page.tsx", "db/0001_init.sql", "package-lock.json", "Dockerfile", "docs/release.md"]);
    expect(excluded.map((entry) => entry.path)).toEqual([".scratch/financial-terminal/map.md", ".env.local", ".secrets/credential-keyring.json"]);
    expect(uncategorized).toHaveLength(0);
    expect(included.find((entry) => entry.path === "db/0001_init.sql")?.category).toBe("migration");
    expect(included.find((entry) => entry.path === ".env.example")?.category).toBe("config");
  });

  it("flags a tracked file that fits no allowed category (fail closed)", () => {
    const { uncategorized } = classifyReleaseFiles(["mystery.bin"]);
    expect(uncategorized).toEqual(["mystery.bin"]);
  });

  it("detects credential formats but passes clean content and the empty env example", () => {
    // Build the credential-shaped fixtures at runtime so the source file itself
    // ships no matching literal (the packager secret-scan would otherwise flag it).
    const anthropicKey = ["sk", "ant", "abcdef1234567890"].join("-");
    const githubKey = ["ghp", "ABCDEFGHIJKLMNOPQRST1"].join("_");
    expect(scanSecrets(`token = ${anthropicKey}`)).not.toHaveLength(0);
    expect(scanSecrets(githubKey)).not.toHaveLength(0);
    expect(scanSecrets("GEMINI_API_KEY=\nALPACA_API_KEY_ID=")).toHaveLength(0);
    expect(scanSecrets("const secret = vault.load();")).toHaveLength(0);
  });
});

describe.skipIf(!releaseGitLane())("F11 release manifest over the real tree", () => {
  it("ships no agent state, env secret, secret store, or vcs metadata", () => {
    const { included, uncategorized } = classifyReleaseFiles(trackedFiles());
    for (const { path } of included) {
      expect(path.startsWith(".scratch/")).toBe(false);
      expect(path.startsWith(".secrets/")).toBe(false);
      expect(path.startsWith(".git/")).toBe(false);
      expect(path === ".env" || (/(^|\/)\.env($|\.)/.test(path) && !path.endsWith(".env.example"))).toBe(false);
    }
    // Every tracked file is either shipped in a known category or explicitly excluded.
    expect(uncategorized).toHaveLength(0);
    const paths = new Set(included.map((entry) => entry.path));
    expect(paths.has(".env.example")).toBe(true);
    expect(paths.has("package-lock.json")).toBe(true);
    expect(paths.has("Dockerfile")).toBe(true);
    // vendor/ is a `file:` dependency of package.json — a release that drops it cannot
    // `npm ci` at all. An exclude rule would make it vanish without tripping the
    // uncategorized check above, so assert inclusion and category directly.
    // Shipping MIT-licensed code without its licence text violates the licence itself.
    expect(paths.has("LICENSE")).toBe(true);
    expect(paths.has("vendor/server-only/package.json")).toBe(true);
    expect(paths.has("vendor/server-only/index.js")).toBe(true);
    expect(included.find((entry) => entry.path === "vendor/server-only/index.js")?.category).toBe("vendor");
  });

  it("builds a manifest with a SHA-256 for every file and no leaked secret", () => {
    const manifest = buildManifest();
    expect(manifest.fileCount).toBeGreaterThan(100);
    expect(manifest.aggregateSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const file of manifest.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(manifest.categories).sort()).toEqual(expect.arrayContaining(["config", "docker", "docs", "lockfile", "source"]));
  });
});
