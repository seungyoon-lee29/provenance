import { describe, expect, it } from "vitest";

import { CONNECTION, ScriptedBrokerReadSource, WORKSPACE, account, cashWire, makeWorker, positionWire, viewer } from "./f10-broker-sync-harness";
import type { WirePage } from "./f10-broker-sync-harness";
import type { BrokerReadWireEvent } from "../src/modules/provider-connections/read-transport/routes";

/**
 * F10 sync budget (spec §11.3 / ticket AC): standard Broker Sync p95 5s at the
 * §11 fixture scale (250 positions / 5 currencies), deep rebuild 20s. Scripted,
 * network-off, injected clock — these budgets catch pathological regressions
 * (quadratic folds, accidental awaits), not micro-variance.
 * ponytail: fixture scaled to 250 pos / 10k activity — full 100k-activity load
 * is F11 load-test territory; this still exercises the paging + fold at scale.
 */

const NOW = () => new Date("2026-07-19T00:00:00.000Z");
const ASOF = "2026-07-19T00:00:00Z";

function p95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

function pagesOf(events: BrokerReadWireEvent[], perPage: number, tag: string): WirePage[] {
  const pages: WirePage[] = [];
  for (let start = 0; start < events.length; start += perPage) {
    pages.push({ events: events.slice(start, start + perPage), checksum: `${tag}-${start}`, asOf: ASOF });
  }
  return pages.length > 0 ? pages : [{ events: [], checksum: `${tag}-empty`, asOf: ASOF }];
}

function activityWire(id: string): BrokerReadWireEvent {
  return { entity: id, kind: "activity", externalIdentity: id, revision: 1, asOf: ASOF, body: { activityKind: "buy", occurredAt: ASOF } };
}

describe("F10 broker sync budget", () => {
  it("meets standard sync p95 5s with 250 positions / 5 currencies", async () => {
    const source = new ScriptedBrokerReadSource();
    source.set("positions", pagesOf(Array.from({ length: 250 }, (_v, i) => positionWire(`I${i}`, i + 1)), 85, "pos"));
    source.set("cash", pagesOf(["USD", "KRW", "EUR", "JPY", "GBP"].map((c, i) => cashWire(c, (i + 1) * 1000)), 5, "cash"));
    source.set("activity", pagesOf(Array.from({ length: 20 }, (_v, i) => activityWire(`A${i}`)), 20, "act"));
    const h = makeWorker(source, NOW);

    const samples: number[] = [];
    for (let run = 0; run < 40; run += 1) {
      const start = performance.now();
      const outcome = await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
      samples.push(performance.now() - start);
      if (outcome.status !== "promoted") throw new Error(`sync ${run} failed: ${outcome.status}`);
    }
    expect(p95(samples)).toBeLessThan(5_000);
  });

  it("meets deep rebuild 20s with 2,000 positions / 10,000 activity", async () => {
    const source = new ScriptedBrokerReadSource();
    source.set("positions", pagesOf(Array.from({ length: 2_000 }, (_v, i) => positionWire(`I${i}`, i + 1)), 250, "pos"));
    source.set("cash", pagesOf(["USD", "KRW", "EUR", "JPY", "GBP"].map((c, i) => cashWire(c, (i + 1) * 1000)), 5, "cash"));
    source.set("activity", pagesOf(Array.from({ length: 10_000 }, (_v, i) => activityWire(`A${i}`)), 500, "act"));
    const h = makeWorker(source, NOW);

    const start = performance.now();
    const outcome = await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    const elapsed = performance.now() - start;
    expect(outcome.status).toBe("promoted");
    expect(elapsed).toBeLessThan(20_000);
  });
});
