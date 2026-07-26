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
 * Scope, stated honestly because an overstated guard is worse than none: the
 * first two cases check only that the document MENTIONS every name and every
 * reason the surfaces can produce — they cannot check that the prose around
 * them is TRUE, which stays a reviewer's job. What they do catch is the silent
 * half of drift: an operation or a refusal reason added to the catalog and
 * never told to the agents that were taught the old shape. The third case is
 * stronger, pinning the published launch form outright, because publishing a
 * broken one is the single documentation error a reader cannot recover from.
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

  it("both documents publish the launch form that keeps stdout clean, and neither publishes the npm one", () => {
    // `npm run` prints its script banner to STDOUT: it breaks a `--json | jq`
    // pipe and, over MCP, corrupts the JSON-RPC stream outright — the client
    // dies on a parse error before it can read anything else. Publishing that
    // invocation is the one documentation error a reader cannot recover from.
    for (const [name, document] of [["SKILL.md", SKILL], ["README.md", README]] as const) {
      expect(document, name).toContain("node --import tsx src/cli/main.ts");
      // Presence alone is weak — a document can show the safe form AND an unsafe
      // alternative and still satisfy it. So the known-unsafe spellings are
      // banned outright. This is a blocklist, not a proof: it stops the
      // spellings someone would actually reach for, not every possible one.
      expect(document.toLowerCase(), name).not.toContain("npm run mcp");
      expect(document, name).not.toContain('"command": "npm"');

      // The published MCP config must actually RUN: `node src/mcp/main.ts`
      // without the loader cannot execute TypeScript, so a config missing
      // `--import tsx` is broken in a way no reader can debug from the page.
      //
      // Asserted on the whitespace-stripped document, which is what makes this
      // both precise and non-brittle. Checking the tokens INDEPENDENTLY does not
      // work: `--import` and `tsx` also occur in every CLI example on the page,
      // so a config that had lost its loader still passed (verified — the
      // mutation stayed green). Checking the exact argv literal instead would
      // fail on a harmless reformat. Stripping whitespace collapses both
      // spellings onto one sequence that prose cannot accidentally satisfy.
      const dense = document.replace(/\s+/g, "");
      expect(dense, `${name} :: MCP argv`).toContain('"--import","tsx","src/mcp/main.ts"');
      expect(dense, `${name} :: MCP command`).toContain('"command":"node"');
    }
  });
});
