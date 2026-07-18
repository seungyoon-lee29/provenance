import { describe, expect, it } from "vitest";

import { CONNECTION, ScriptedBrokerReadSource, WORKSPACE, account, cashWire, makeWorker, positionWire, viewer } from "./f10-broker-sync-harness";

const NOW = () => new Date("2026-07-19T00:00:00.000Z");

function baseSource(): ScriptedBrokerReadSource {
  const source = new ScriptedBrokerReadSource();
  source.set("positions", [{ events: [positionWire("AAPL", 10)], checksum: "pos-0", asOf: "2026-07-19T00:00:00Z" }]);
  source.set("cash", [{ events: [cashWire("USD", 5000)], checksum: "cash-0", asOf: "2026-07-19T00:00:00Z" }]);
  source.set("activity", []); // present-and-empty
  return source;
}

describe("F10 broker sync worker", () => {
  it("pages every component and promotes a complete snapshot", async () => {
    const h = makeWorker(baseSource(), NOW);
    const outcome = await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    expect(outcome.status).toBe("promoted");
    const view = h.snapshots.current(WORKSPACE, account(), NOW());
    expect(view.status).toBe("fresh");
    if (view.status === "fresh") {
      expect(view.projection.positions.map((row) => row.entity)).toEqual(["AAPL"]);
      expect(view.projection.components.activity).toBe("present");
    }
    expect(h.cursors.provisionalWatermark(WORKSPACE, account())).toBe("2026-07-19T00:00:00Z");
  });

  it("holds a cursor reset and preserves the last complete snapshot", async () => {
    const source = baseSource();
    source.set("positions", [
      { events: [positionWire("AAPL", 10)], checksum: "p0", asOf: "2026-07-19T00:00:00Z" },
      { events: [positionWire("MSFT", 4, 1)], checksum: "p1", asOf: "2026-07-19T00:00:00Z" },
    ]);
    const h = makeWorker(source, NOW);
    expect((await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION)).status).toBe("promoted");
    source.resetCursor = { component: "positions", atCursor: "1" }; // page 1 comes back as pageIndex 0
    const held = await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    expect(held).toEqual({ status: "held", reason: "cursor_reset" });
    expect(h.snapshots.current(WORKSPACE, account(), NOW()).status).toBe("fresh");
  });

  it("holds a page gap (manifest declares more pages than delivered)", async () => {
    const source = baseSource();
    source.overridePageCount("positions", 2); // only one page is served
    const h = makeWorker(source, NOW);
    const outcome = await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    expect(outcome).toEqual({ status: "held", reason: "gap" });
  });

  it("holds a divergent component checksum", async () => {
    const source = baseSource();
    source.overrideChecksum("cash", "tampered");
    const h = makeWorker(source, NOW);
    expect(await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION)).toEqual({ status: "held", reason: "divergent_checksum" });
  });

  it("reports unauthorized without touching the snapshot when the connection is revoked", async () => {
    const h = makeWorker(baseSource(), NOW);
    h.revoke();
    expect((await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION)).status).toBe("unauthorized");
    expect(h.snapshots.current(WORKSPACE, account(), NOW()).status).toBe("none");
  });

  it("converges on restart: a fresh worker re-pages to the same snapshot with no double-count", async () => {
    const source = baseSource();
    const h = makeWorker(source, NOW);
    await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    const before = h.snapshots.current(WORKSPACE, account(), NOW());
    await h.restartedWorker().sync(WORKSPACE, viewer(), account(), CONNECTION);
    const after = h.snapshots.current(WORKSPACE, account(), NOW());
    expect(after).toEqual(before);
    if (after.status === "fresh") expect(after.projection.positions).toHaveLength(1);
  });

  it("starts a fresh namespace on a new provider data epoch (old positions do not leak)", async () => {
    const source = baseSource();
    const h = makeWorker(source, NOW);
    await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    // Provider ledger reset: new epoch, new positions only.
    source.lineage = { ...source.lineage, providerDataEpoch: 2 };
    source.set("positions", [{ events: [positionWire("MSFT", 7)], checksum: "p0-e2", asOf: "2026-07-19T00:00:00Z" }]);
    expect((await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION)).status).toBe("promoted");
    const view = h.snapshots.current(WORKSPACE, account(), NOW());
    if (view.status === "fresh") expect(view.projection.positions.map((row) => row.entity)).toEqual(["MSFT"]);
    expect(h.cursors.lineageKeyOf(WORKSPACE, account())).toContain("|2");
  });

  it("replaces the projection when a newer snapshot restates a position (read-sync semantics)", async () => {
    const source = baseSource();
    const h = makeWorker(source, NOW);
    await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    // A fresh full snapshot at a later time: every component moves together (within skew).
    source.snapshotAsOf = "2026-07-19T00:05:00Z";
    source.set("positions", [{ events: [positionWire("AAPL", 12, 2, { asOf: "2026-07-19T00:05:00Z" })], checksum: "p0b", asOf: "2026-07-19T00:05:00Z" }]);
    source.set("cash", [{ events: [cashWire("USD", 5000)], checksum: "cash-0", asOf: "2026-07-19T00:05:00Z" }]);
    expect((await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION)).status).toBe("promoted");
    const view = h.snapshots.current(WORKSPACE, account(), NOW());
    if (view.status === "fresh") expect(view.projection.positions.map((row) => row.body.signedQuantity)).toEqual([12]);
  });

  it("advances the provisional watermark on a held run but not the safe watermark", async () => {
    const source = baseSource();
    const h = makeWorker(source, NOW);
    await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    expect(h.snapshots.safeWatermark(WORKSPACE, account())).toBe("2026-07-19T00:00:00Z");
    // A newer but incomplete run (divergent checksum) still receives fresher pages.
    source.snapshotAsOf = "2026-07-19T00:09:00Z";
    source.set("cash", [{ events: [cashWire("USD", 5000)], checksum: "cash-0", asOf: "2026-07-19T00:09:00Z" }]);
    source.overrideChecksum("positions", "tampered");
    source.set("positions", [{ events: [positionWire("AAPL", 10)], checksum: "p0", asOf: "2026-07-19T00:09:00Z" }]);
    expect((await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION)).status).toBe("held");
    expect(h.cursors.provisionalWatermark(WORKSPACE, account())).toBe("2026-07-19T00:09:00Z");
    expect(h.snapshots.safeWatermark(WORKSPACE, account())).toBe("2026-07-19T00:00:00Z");
  });
});
