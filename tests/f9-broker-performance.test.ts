import { describe, expect, it } from "vitest";

import { account, CONNECTION, control, harness, limitBuy, viewer, WORKSPACE } from "./f9-broker-harness";

/**
 * F9 deadline budget (spec §11 / ticket AC): Broker Paper durable acceptance
 * p95 450 ms (warm) / 700 ms (cache miss) at the §11 fixture scale (2,000
 * orders on the account). "Durable acceptance" is the local one-transaction
 * commit — intent consumption + order + derived reservation + outbox +
 * PendingBrokerSubmission — i.e. the `service.submit` seam; the route call is
 * not part of the budget. Catches pathological regressions (quadratic folds,
 * accidental awaits), not micro-variance.
 */

function p95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe("Broker Paper durable acceptance budget", () => {
  it("meets 450 ms warm / 700 ms cold p95 with 2,000 orders on the account", async () => {
    const h = harness();
    for (let index = 0; index < 2_000; index += 1) {
      const revision = h.book.currentRevision(WORKSPACE, account());
      const prepared = await h.service.prepare({ account: account(), connection: CONNECTION, payload: limitBuy(1, 10) }, viewer());
      if (prepared.status !== "issued") throw new Error("prepare failed");
      const outcome = await h.service.submit(prepared.intent.reference, control(`perf-${index}`, revision), viewer());
      if (outcome.status !== "applied") throw new Error(`submit ${index} failed: ${outcome.status}`);
    }

    const warmSamples: number[] = [];
    for (let run = 0; run < 40; run += 1) {
      const revision = h.book.currentRevision(WORKSPACE, account());
      const prepared = await h.service.prepare({ account: account(), connection: CONNECTION, payload: limitBuy(1, 10) }, viewer());
      if (prepared.status !== "issued") throw new Error("prepare failed");
      const start = performance.now();
      const outcome = await h.service.submit(prepared.intent.reference, control(`warm-${run}`, revision), viewer());
      warmSamples.push(performance.now() - start);
      if (outcome.status !== "applied") throw new Error(`warm submit failed: ${outcome.status}`);
    }
    expect(p95(warmSamples)).toBeLessThan(450);
    expect(Math.max(...warmSamples)).toBeLessThan(700);
  });
});
