import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Standing invariant (ticket 21, ADR 0004, issue 04): the Actual and Paper
 * lanes share no ledger, aggregate, storage, mode interface, or order
 * interface. Reuse of PURE calculation rules is explicitly allowed (issue 04:7),
 * so this asserts the structural boundary — neither module tree imports the
 * other — not "no shared calculation". Branded reference incompatibility is
 * additionally enforced by the type checker at compile time.
 */

const ROOT = resolve(import.meta.dirname, "../..");

function crossImports(fromTree: string, forbiddenTree: string): string[] {
  const output = execFileSync(
    "git",
    ["grep", "-nE", `from ['\"][^'\"]*${forbiddenTree}`, "--", `src/modules/${fromTree}/`],
    { cwd: ROOT, encoding: "utf8" },
  ).trim();
  return output.length === 0 ? [] : output.split("\n");
}

function safeCrossImports(fromTree: string, forbiddenTree: string): string[] {
  try {
    return crossImports(fromTree, forbiddenTree);
  } catch (error) {
    // git grep exits 1 with no matches — that is the passing case.
    if (error instanceof Error && "status" in error && (error as { status: number }).status === 1) return [];
    throw error;
  }
}

describe("actual/paper ledger isolation", () => {
  it("the paper-trading tree never imports the actual-portfolio tree", () => {
    expect(safeCrossImports("paper-trading", "actual-portfolio")).toEqual([]);
  });

  it("the actual-portfolio tree never imports the paper-trading tree", () => {
    expect(safeCrossImports("actual-portfolio", "paper-trading")).toEqual([]);
  });
});
