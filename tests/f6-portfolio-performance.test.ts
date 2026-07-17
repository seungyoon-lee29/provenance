import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import { ActualJournal } from "../src/modules/actual-portfolio/baseline/journal";
import { ActualPortfolioService } from "../src/modules/actual-portfolio/baseline/portfolio-load";
import type { ActualAccountReference } from "../src/modules/actual-portfolio/baseline/contracts";

/**
 * F6 deadline budget (spec §11 / ticket AC): Actual initial projection p95
 * 450 ms (warm) / 800 ms (cold) against a realistically populated journal.
 * Asserted on the real open() seam in the scripted lane — this catches
 * pathological regressions (accidental awaits, quadratic scans), not
 * micro-variance.
 */

const NOW = "2026-07-17T06:00:00.000Z";

function p95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

function viewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-perf",
    workspaceReference: brandReference<string, "WorkspaceReference">("workspace:perf"),
    accountReference: brandReference<string, "AccountReference">("account:perf"),
    sessionReference: brandReference<string, "SessionReference">("session:perf"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
  };
}

describe("Actual initial projection budget", () => {
  it("meets 450 ms warm / 800 ms cold p95 with 10 accounts x 50 entries", async () => {
    const journal = new ActualJournal(() => NOW);
    for (let accountIndex = 0; accountIndex < 10; accountIndex += 1) {
      const account = brandReference<string, "ActualAccountReference">(`actual-account:p${accountIndex}`) as ActualAccountReference;
      for (let entryIndex = 0; entryIndex < 50; entryIndex += 1) {
        journal.append("workspace:perf", {
          kind: "record_opening_position",
          account,
          position: {
            instrument: brandReference<string, "ActualInstrumentReference">(`instr:${accountIndex}:${entryIndex}`),
            signedQuantity: 1 + entryIndex,
            currency: "KRW",
            asOf: "2026-07-01",
            source: brandReference<string, "ActualSourceReference">(`source:perf:${accountIndex}:${entryIndex}`),
          },
        }, { idempotencyKey: `k${accountIndex}:${entryIndex}`, expectedRevision: String(entryIndex) });
      }
    }
    const service = new ActualPortfolioService({
      journal,
      port: {
        quote: () => ({ available: true, unitPrice: { amount: 70_000, currency: "KRW" }, asOf: NOW }),
        fxRate: (from, to) => (from === to ? { available: true, rate: 1, asOf: NOW } : { available: false }),
      },
      identity: { currentAuthorizationEpoch: () => "epoch:1" },
      policyVersion: "policy:f6-1",
      now: () => NOW,
      updateId: () => "update:perf",
    });

    const openOnce = async (): Promise<number> => {
      const startedAt = performance.now();
      const load = service.open({ sections: ["positions", "valuation"], requestRevision: "r-perf" }, viewer());
      const initial = await load.initial;
      const elapsed = performance.now() - startedAt;
      if (initial.status !== "ready" || initial.positions.length !== 500) throw new Error("perf shell incomplete");
      return elapsed;
    };

    const cold = await openOnce();
    const warm: number[] = [];
    for (let index = 0; index < 50; index += 1) warm.push(await openOnce());
    expect(cold).toBeLessThanOrEqual(800);
    expect(p95(warm)).toBeLessThanOrEqual(450);
  });
});
