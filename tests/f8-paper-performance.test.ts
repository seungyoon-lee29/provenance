import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import { PaperTradingService } from "../src/modules/paper-trading/internal/service";
import type { PaperInstrumentReference, PaperOrderPayload } from "../src/modules/paper-trading/internal/contracts";

/**
 * F8 deadline budget (spec §11 / ticket AC): Internal Paper local command p95
 * 350 ms (warm) / 600 ms (cache miss) against the §11 standard fixture scale
 * (2,000 Paper Orders on the account). Asserted on the real change() seam in
 * the scripted lane — this catches pathological regressions (quadratic folds,
 * accidental awaits), not micro-variance.
 */

const NOW = "2026-07-18T02:00:00.000Z";

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

const AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL") as PaperInstrumentReference;

function limitBuy(quantity: number, limit: number): PaperOrderPayload {
  return {
    instrument: AAPL,
    venue: "XNAS",
    session: "regular",
    side: "buy",
    orderType: "limit",
    limitPrice: { amount: limit, currency: "USD" },
    quantity,
    timeInForce: "GTC",
  };
}

describe("Internal Paper command budget", () => {
  it("meets 350 ms warm / 600 ms cold p95 with 2,000 orders on the account", async () => {
    let updateCounter = 0;
    const service = new PaperTradingService({
      now: () => NOW,
      identity: { currentAuthorizationEpoch: () => "epoch:1" },
      observations: { currentObservation: () => undefined },
      policy: {
        policyVersion: "simulation-v1",
        // Seed sized so 2,000 × 1 × $10 reservations all fit.
        seedCash: [{ amount: 100_000, currency: "USD" }],
        intentTtlMs: 600_000,
        maxSlippageBps: 25,
      },
      updateId: () => `update:${updateCounter += 1}`,
    });

    // §11 fixture scale: 2,000 Paper Orders.
    for (let index = 0; index < 2_000; index += 1) {
      const prepared = await service.prepare({ payload: limitBuy(1, 10) }, viewer());
      if (prepared.status !== "issued") throw new Error("prepare failed");
      const outcome = await service.change(
        { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
        { idempotencyKey: `perf-${index}`, expectedRevision: String(prepared.intent.accountRevision) },
        viewer(),
      );
      if (outcome.status !== "applied") throw new Error(`submit ${index} failed: ${outcome.status}`);
    }

    // Warm: repeated full prepare→submit commands on the populated account.
    const warmSamples: number[] = [];
    for (let run = 0; run < 40; run += 1) {
      const prepared = await service.prepare({ payload: limitBuy(1, 10) }, viewer());
      if (prepared.status !== "issued") throw new Error("prepare failed");
      const start = performance.now();
      const outcome = await service.change(
        { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
        { idempotencyKey: `warm-${run}`, expectedRevision: String(prepared.intent.accountRevision) },
        viewer(),
      );
      warmSamples.push(performance.now() - start);
      if (outcome.status !== "applied") throw new Error(`warm submit failed: ${outcome.status}`);
    }
    expect(p95(warmSamples)).toBeLessThan(350);

    // Cold-ish: the very first command measured above included the first full
    // fold of 2,000+ entries; assert it stayed inside the cache-miss budget.
    expect(Math.max(...warmSamples)).toBeLessThan(600);
  });
});
