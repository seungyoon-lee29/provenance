import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Standing invariant (ticket 21, ADR 0004, issue 04): the Actual and Paper
 * lanes share no ledger, aggregate, storage, mode interface, or order
 * interface. Reuse of PURE calculation rules is explicitly allowed (issue 04:7),
 * so this asserts the structural boundary — neither module tree imports the
 * other — not "no shared calculation". Branded reference incompatibility is
 * additionally enforced by the type checker at compile time.
 *
 * Filesystem-based (not `git grep`) so it runs identically in a container build
 * where `.git` and the git CLI are absent.
 */

const ROOT = resolve(import.meta.dirname, "../..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function crossImports(fromTree: string, forbiddenTree: string): string[] {
  const pattern = new RegExp(`from ['"][^'"]*${forbiddenTree}`);
  return tsFiles(resolve(ROOT, `src/modules/${fromTree}`))
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(ROOT.length + 1));
}

describe("actual/paper ledger isolation", () => {
  it("the paper-trading tree never imports the actual-portfolio tree", () => {
    expect(crossImports("paper-trading", "actual-portfolio")).toEqual([]);
  });

  it("the actual-portfolio tree never imports the paper-trading tree", () => {
    expect(crossImports("actual-portfolio", "paper-trading")).toEqual([]);
  });
});
