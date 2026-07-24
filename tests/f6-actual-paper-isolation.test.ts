import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { ActualAccountReference, ActualSourceReference } from "../src/modules/actual-portfolio/calculation/actual-refs";
import type { AccountReference, SourceReference } from "@/shared/contracts/brands";

/**
 * ADR A04: Actual and Paper share no types, storage or interfaces. The brand
 * assertions below are enforced by `tsc --noEmit` (part of check and the
 * pre-commit hook); the runtime scan pins the module boundary in source.
 */

describe("A04: Actual ledger isolation", () => {
  it("Actual brands are not interchangeable with identity/shared brands", () => {
    const identityAccount: AccountReference = brandReference<string, "AccountReference">("account:x");
    const evidenceSource: SourceReference = brandReference<string, "SourceReference">("source:x");

    // @ts-expect-error an identity account is not an Actual account
    const wrongAccount: ActualAccountReference = identityAccount;
    // @ts-expect-error an evidence source is not an Actual source provenance
    const wrongSource: ActualSourceReference = evidenceSource;
    // @ts-expect-error a raw string is not an Actual account
    const rawAccount: ActualAccountReference = "actual-account:a1";

    expect([wrongAccount, wrongSource, rawAccount]).toBeDefined();
  });

  it("actual-portfolio sources import no paper/live-trading module", () => {
    const root = path.resolve("src/modules/actual-portfolio");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from\s+["'].*paper/i);
      expect(source, file).not.toMatch(/live[-_]?trading/i);
      // No generic mode-switched portfolio interface either (A04).
      expect(source, file).not.toMatch(/mode\s*:\s*["'](actual|paper)["']/i);
    }
  });
});
