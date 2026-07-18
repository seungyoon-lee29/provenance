import { describe, expect, it } from "vitest";

import { CONNECTION, ScriptedBrokerReadSource, WORKSPACE, account, cashWire, makeWorker, positionWire, viewer } from "./f10-broker-sync-harness";

const NOW = () => new Date("2026-07-19T00:00:00.000Z");

function baseSource(): ScriptedBrokerReadSource {
  const source = new ScriptedBrokerReadSource();
  source.set("positions", [{ events: [positionWire("AAPL", 10)], checksum: "pos-0", asOf: "2026-07-19T00:00:00Z" }]);
  source.set("cash", [{ events: [cashWire("USD", 5000)], checksum: "cash-0", asOf: "2026-07-19T00:00:00Z" }]);
  source.set("activity", []);
  return source;
}

describe("F10 broker sync lifecycle — disconnect retain / reconnect", () => {
  it("freezes a disconnected account (no current value) and a fresh sync restores currency", async () => {
    const source = baseSource();
    const h = makeWorker(source, NOW);
    await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);

    h.snapshots.disconnect(WORKSPACE, account());
    const frozen = h.snapshots.current(WORKSPACE, account(), NOW());
    expect(frozen.status).toBe("disconnected");
    expect("projection" in frozen).toBe(false); // excluded from current total — frozen evidence only
    if (frozen.status === "disconnected") expect(frozen.frozen.positions.map((row) => row.entity)).toEqual(["AAPL"]);

    // Reconnect: a fresh complete sync at a later time restores currency.
    source.snapshotAsOf = "2026-07-19T00:05:00Z";
    source.set("positions", [{ events: [positionWire("AAPL", 11, 2, { asOf: "2026-07-19T00:05:00Z" })], checksum: "pos-1", asOf: "2026-07-19T00:05:00Z" }]);
    source.set("cash", [{ events: [cashWire("USD", 5000)], checksum: "cash-0", asOf: "2026-07-19T00:05:00Z" }]);
    expect((await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION)).status).toBe("promoted");
    const view = h.snapshots.current(WORKSPACE, account(), NOW());
    expect(view.status).toBe("fresh");
    if (view.status === "fresh") expect(view.projection.positions.map((row) => row.body.signedQuantity)).toEqual([11]);
  });

  it("keeps the safe watermark as frozen evidence while disconnected", async () => {
    const h = makeWorker(baseSource(), NOW);
    await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    h.snapshots.disconnect(WORKSPACE, account());
    const frozen = h.snapshots.current(WORKSPACE, account(), NOW());
    if (frozen.status === "disconnected") expect(frozen.safeWatermark).toBe("2026-07-19T00:00:00Z");
    expect(h.snapshots.safeWatermark(WORKSPACE, account())).toBe("2026-07-19T00:00:00Z");
  });
});
