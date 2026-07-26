import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { OPERATION_REASON_TO_CLI } from "../src/cli/commands";
import { operationCatalog } from "../src/operations/catalog";

/**
 * T10 S4 — SKILL.md is a CONTRACT, not prose.
 *
 * The moment an agent is told "branch on this reason" or "call this operation",
 * the document joins the set of definitions that must not drift from the code.
 * Every other such pair in this repo is pinned by a test (the MCP server's
 * import list, the CLI's exhaustive reason mapping); this is the same guard for
 * the one definition that lives in Markdown.
 *
 * Scope, deliberately narrow: it checks that the document MENTIONS every name
 * and every reason the surfaces can produce. It cannot check that the prose
 * around them is true — that is a reviewer's job. What it does catch is the
 * silent half of drift: an operation or a refusal reason added to the catalog
 * and never told to the agents that were taught the old shape.
 */

const ROOT = resolve(import.meta.dirname, "..");
const SKILL = readFileSync(resolve(ROOT, "SKILL.md"), "utf8");
const README = readFileSync(resolve(ROOT, "README.md"), "utf8");

describe("T10 S4 — agent onboarding documents", () => {
  it("SKILL.md names every operation the catalog serves", () => {
    const missing = operationCatalog()
      .list()
      .map((operation) => operation.name)
      .filter((name) => !SKILL.includes(name));
    expect(missing).toEqual([]);
  });

  it("SKILL.md documents every refusal reason a surface can return", () => {
    // The CLI's mapping is exhaustive BY TYPE over `OperationRefusalReason`, so
    // its keys are the whole union at runtime — adding a reason without adding
    // it here is impossible without also failing the compiler there.
    const missing = Object.keys(OPERATION_REASON_TO_CLI).filter((reason) => !SKILL.includes(reason));
    expect(missing).toEqual([]);
  });

  it("both documents publish the launch form that keeps stdout clean", () => {
    // `npm run` prints its script banner to STDOUT: it breaks a `--json | jq`
    // pipe and, over MCP, corrupts the JSON-RPC stream outright. Publishing the
    // wrong invocation is the one documentation error that cannot be recovered
    // from by reading further, so the exact working form is pinned.
    for (const [name, document] of [["SKILL.md", SKILL], ["README.md", README]] as const) {
      expect(document, name).toContain("node --import tsx src/cli/main.ts");
      expect(document, name).toContain("src/mcp/main.ts");
    }
  });
});
