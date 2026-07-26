/**
 * F11 release packaging — pure allowlist + secret-scan logic (spec §13.2, AC).
 *
 * The release ZIP ships exactly the tracked deliverable: source, lockfile,
 * vendored local dependencies (`vendor/`, resolved by `npm ci` from disk),
 * Docker, migration, docs and manifests. It excludes agent working state
 * (`.scratch/`), any `.env*` except `.env.example`, `.secrets/`, `.git/`, and
 * every build/cache/raw artifact. `git ls-files` already drops gitignored paths
 * (`.env.local`, `.secrets/`, `node_modules`, `dist`, `*.zip`), so the one
 * category that is tracked-but-not-shipped is `.scratch/`; the rest are
 * defensive. Every shipped file is also assigned a release category, so an
 * un-categorizable tracked file fails the manifest closed rather than shipping.
 */

/** Known credential FORMATS (mirrors the pre-commit hook — not generic entropy). */
export const RELEASE_SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /sk-[A-Za-z0-9]{24,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /gho_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[bap]-[A-Za-z0-9-]{10,}/,
  /whsec_[A-Za-z0-9]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
];

export type ExcludeRule = Readonly<{ test: (path: string) => boolean; reason: string }>;

export const RELEASE_EXCLUDE_RULES: readonly ExcludeRule[] = [
  { test: (p) => p === ".scratch" || p.startsWith(".scratch/"), reason: "agent working state" },
  { test: (p) => p === ".git" || p.startsWith(".git/"), reason: "vcs metadata" },
  { test: (p) => p.startsWith("node_modules/"), reason: "dependency cache" },
  { test: (p) => p.startsWith("test-results/") || p.startsWith("dist/") || p.startsWith(".next/") || p.startsWith("coverage/"), reason: "build/cache artifact" },
  // .env.example is the only permitted env file; every other .env* is a secret carrier.
  { test: (p) => (p === ".env" || /(^|\/)\.env($|\.)/.test(p)) && !p.endsWith(".env.example"), reason: "environment secret file" },
  { test: (p) => p === ".secrets" || p.startsWith(".secrets/"), reason: "secret store" },
  { test: (p) => p.endsWith(".zip") || p.endsWith(".log") || p === ".DS_Store" || p.endsWith("/.DS_Store"), reason: "archive/log/os cruft" },
];

type CategoryRule = Readonly<{ test: (path: string) => boolean; category: string }>;

const CATEGORY_RULES: readonly CategoryRule[] = [
  { test: (p) => p === "package.json" || p === "package-lock.json", category: "lockfile" },
  // vendor/ holds the `file:` no-op stand-in for the `server-only` marker. `npm ci` resolves it
  // from disk, so a release that omits it cannot install at all. Ships, deliberately.
  { test: (p) => p.startsWith("vendor/"), category: "vendor" },
  { test: (p) => p === "Dockerfile" || p === "compose.yaml" || p === ".dockerignore", category: "docker" },
  { test: (p) => p.startsWith("db/") || p === "scripts/migrate.ts", category: "migration" },
  // LICENSE has no extension, so the uppercase-.md rule below does not reach it. It must ship:
  // an MIT release that omits its own licence text violates the licence it ships under.
  { test: (p) => p === "LICENSE", category: "docs" },
  { test: (p) => p.startsWith("docs/") || /^[A-Z0-9_]+\.md$/.test(p) || p.endsWith("/manifest.json") || p.startsWith("dist/release/"), category: "docs" },
  { test: (p) => p.startsWith("src/") || p.startsWith("tests/") || p.startsWith("scripts/") || p.startsWith("fixtures/"), category: "source" },
  { test: (p) => p.startsWith(".github/"), category: "ci" }, // CI workflows — remote gate infra, like .husky/ hooks
  {
    test: (p) =>
      p === ".gitignore" || p === ".env.example" || p.startsWith(".husky/") || p === "tsconfig.json"
      || p === "next.config.ts" || p === "next-env.d.ts"
      || /^[a-z0-9.-]*\.config\.(ts|mjs|js)$/.test(p) // root vitest/eslint/stryker/playwright configs
      || (p.startsWith("playwright") && p.endsWith(".ts")),
    category: "config",
  },
];

/** The release category of a shipped file, or undefined if it fits no allowed category. */
export function releaseCategory(path: string): string | undefined {
  return CATEGORY_RULES.find((rule) => rule.test(path))?.category;
}

export type ReleaseClassification = Readonly<{
  included: readonly Readonly<{ path: string; category: string }>[];
  excluded: readonly Readonly<{ path: string; reason: string }>[];
  /** Tracked, not excluded, but fitting no allowed release category — a fail-closed signal. */
  uncategorized: readonly string[];
}>;

export function classifyReleaseFiles(trackedFiles: readonly string[]): ReleaseClassification {
  const included: { path: string; category: string }[] = [];
  const excluded: { path: string; reason: string }[] = [];
  const uncategorized: string[] = [];
  for (const path of trackedFiles) {
    const rule = RELEASE_EXCLUDE_RULES.find((exclude) => exclude.test(path));
    if (rule !== undefined) {
      excluded.push({ path, reason: rule.reason });
      continue;
    }
    const category = releaseCategory(path);
    if (category === undefined) {
      uncategorized.push(path);
      continue;
    }
    included.push({ path, category });
  }
  return { included, excluded, uncategorized };
}

/** Every secret pattern that matches somewhere in the content (empty = clean). */
export function scanSecrets(content: string): readonly string[] {
  return RELEASE_SECRET_PATTERNS.filter((pattern) => pattern.test(content)).map((pattern) => pattern.source);
}
