import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * F11 doc gate (spec §13.2, AC): every relative Markdown link in the tracked
 * docs must resolve, and every `npm run <script>` a doc references must exist —
 * a "stale-contract" guard so docs can't cite a command that was renamed away.
 */

const ROOT = resolve(import.meta.dirname, "..");

export type DocCheckResult = Readonly<{
  brokenLinks: readonly Readonly<{ doc: string; link: string }>[];
  missingScripts: readonly Readonly<{ doc: string; script: string }>[];
  checkedDocs: number;
}>;

function trackedMarkdown(): string[] {
  return execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith(".scratch/"));
}

const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
/**
 * `npm run [flags…] <script>`. The flag prefix is consumed so the SCRIPT NAME is
 * what gets captured: `npm run --silent cli -- …` must check `cli`, not
 * `--silent`. Capturing the first token instead both reported a flag as a stale
 * script (a false positive that made documenting the flag impossible) and let a
 * genuinely stale `npm run --silent no-such-script` through unreported.
 *
 * A flag is `-` followed by anything non-space, so `--workspace=pkg` and a bare
 * `--` separator are consumed too — matching only `-{1,2}[a-z0-9-]+` left
 * `--workspace=pkg` to be captured AS the script name, reintroducing the very
 * false positive this regex exists to remove. Script names allow uppercase
 * because npm does; excluding it made `npm run Build` match nothing at all,
 * which is a silent miss rather than a report.
 *
 * Two more traps, both found by attacking this regex rather than reading it:
 * the separator is HORIZONTAL space only, because `\s` let `npm run --if-present`
 * at end of line reach across the newline and capture the next line's first word
 * as the script name; and a script name must START alphanumeric, because
 * otherwise that same trailing flag was itself captured as the script.
 *
 * Known residual: `npm run --workspace pkg build` (flag whose value is a
 * SEPARATE token) reports `pkg`. Resolving it needs npm's per-flag arity table,
 * which is not worth carrying — this repo has no workspaces, and the failure is
 * a loud false positive rather than a silent miss.
 */
const SCRIPT = /npm run ((?:-\S+[^\S\n]+)*)([A-Za-z0-9][A-Za-z0-9:_-]*)/g;

export function checkReleaseDocs(): DocCheckResult {
  const scripts = new Set(Object.keys(JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).scripts ?? {}));
  const brokenLinks: { doc: string; link: string }[] = [];
  const missingScripts: { doc: string; script: string }[] = [];
  const docs = trackedMarkdown();

  for (const doc of docs) {
    const content = readFileSync(resolve(ROOT, doc), "utf8");
    for (const match of content.matchAll(LINK)) {
      const target = match[1]!.trim();
      if (/^(https?:|mailto:|#)/.test(target)) continue; // external or in-page anchor
      const path = target.split("#")[0]!;
      if (path.length === 0) continue;
      if (!existsSync(resolve(ROOT, dirname(doc), path))) brokenLinks.push({ doc, link: target });
    }
    for (const match of content.matchAll(SCRIPT)) {
      const script = match[2]!;
      if (!scripts.has(script)) missingScripts.push({ doc, script });
    }
  }
  return { brokenLinks, missingScripts, checkedDocs: docs.length };
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  const result = checkReleaseDocs();
  for (const { doc, link } of result.brokenLinks) process.stderr.write(`broken link: ${doc} -> ${link}\n`);
  for (const { doc, script } of result.missingScripts) process.stderr.write(`stale script ref: ${doc} -> npm run ${script}\n`);
  const failures = result.brokenLinks.length + result.missingScripts.length;
  process.stdout.write(`check-release-docs: ${result.checkedDocs} docs, ${failures} problem(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}
