import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The client-bundle invariant, made mechanical (2026-07-26).
 *
 * `next build` is the only thing that actually enforces "this module must not reach the
 * browser", and it enforces it ONLY for modules carrying `import "server-only"`. Measured:
 * a plain `export const SECRET = "..."` module with no node-builtin dependency, imported
 * AND used inside a "use client" file, passes both `tsc --noEmit` and `next build`. Add the
 * marker and the same build fails. So the marker is the gate, and an unmarked sensitive
 * module is an unguarded one.
 *
 * Before this, coverage was accidental: `dependencies.ts` was caught only because `pg`
 * requires `dns`/`net`/`tls`, which Turbopack cannot resolve for a browser target. That is
 * a coincidence, not a guarantee — `pg.ts` imports `pg` as `import type` only and drags
 * nothing, and swapping to a fetch/WebSocket driver would silently delete the coverage.
 *
 * This test does not check bundling — it checks that nobody adds a file to the server-only
 * surface without the marker. `next build` (Dockerfile:13, CI PR-integration) does the real
 * transitive enforcement.
 */
const SERVER_ONLY_DIRS = ["src/platform/runtime", "src/platform/persistence", "src/platform/credential-vault"];

const MARKER = 'import "server-only";';

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) => join(dir, name));
}

describe("server-only marker", () => {
  it("covers every file on the server-only surface", () => {
    const unmarked = SERVER_ONLY_DIRS.flatMap(tsFilesIn).filter((file) => !readFileSync(file, "utf8").startsWith(MARKER));

    expect(unmarked).toEqual([]);
  });

  it("guards a surface that is not empty (the check above passes vacuously otherwise)", () => {
    expect(SERVER_ONLY_DIRS.flatMap(tsFilesIn).length).toBeGreaterThanOrEqual(11);
  });
});
