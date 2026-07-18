import { describe, expect, it } from "vitest";

import { CONNECTION, ScriptedBrokerReadSource, WORKSPACE, account, cashWire, makeWorker, positionWire, viewer } from "./f10-broker-sync-harness";
import { ActualJournal } from "../src/modules/actual-portfolio/baseline/journal";
import { ActualPortfolioErasure } from "../src/modules/actual-portfolio/baseline/actual-erasure";
import { brokerSyncErasables } from "../src/modules/actual-portfolio/broker-sync/broker-erasure";
import { BROKER_SYNC_LIVE_EPOCH } from "../src/modules/actual-portfolio/broker-sync/event-store";

const NOW = () => new Date("2026-07-19T00:00:00.000Z");
const FENCE = BROKER_SYNC_LIVE_EPOCH + 1;

function baseSource(): ScriptedBrokerReadSource {
  const source = new ScriptedBrokerReadSource();
  source.set("positions", [{ events: [positionWire("AAPL", 10)], checksum: "pos-0", asOf: "2026-07-19T00:00:00Z" }]);
  source.set("cash", [{ events: [cashWire("USD", 5000)], checksum: "cash-0", asOf: "2026-07-19T00:00:00Z" }]);
  source.set("activity", []);
  return source;
}

describe("F10 broker sync erasure (SEC-09)", () => {
  it("shreds every broker-sync store behind one coordinator fence and collects a receipt", async () => {
    const source = baseSource();
    const h = makeWorker(source, NOW);
    await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);

    const erasure = new ActualPortfolioErasure({
      journal: new ActualJournal(() => "2026-07-19T00:00:00Z"),
      stores: brokerSyncErasables({ events: h.events, snapshots: h.snapshots, cursors: h.cursors }),
    });
    await erasure.erase({ accountReference: String(account()), workspaceReference: WORKSPACE, scope: "workspace", fence: FENCE });

    const receipt = erasure.receiptFor(WORKSPACE);
    expect(receipt).toBeDefined();
    const brokerLines = receipt!.lines.filter((line) => line.label.startsWith("broker-sync"));
    expect(brokerLines.length).toBeGreaterThan(0);
    // At least the event facts (AAPL + USD) and the current snapshot were shredded.
    const shredded = Object.fromEntries(brokerLines.map((line) => [line.label, line.shredded]));
    expect(shredded["broker-sync-events-0"]).toBeGreaterThanOrEqual(2);
    expect(shredded["broker-sync-snapshot-0"]).toBeGreaterThanOrEqual(1);

    // Data is gone.
    expect(h.snapshots.current(WORKSPACE, account(), NOW()).status).toBe("none");
    expect(h.cursors.provisionalWatermark(WORKSPACE, account())).toBeUndefined();
  });

  it("after the fence: broker read, snapshot promotion, and late event commit are all zero", async () => {
    const source = baseSource();
    const h = makeWorker(source, NOW);
    await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION);
    const erasure = new ActualPortfolioErasure({
      journal: new ActualJournal(() => "2026-07-19T00:00:00Z"),
      stores: brokerSyncErasables({ events: h.events, snapshots: h.snapshots, cursors: h.cursors }),
    });
    await erasure.erase({ accountReference: String(account()), workspaceReference: WORKSPACE, scope: "workspace", fence: FENCE });

    const readsBefore = source.checksumCalls + source.pageCalls;
    // A late sync must not touch the network and must not resurrect state.
    expect((await h.worker.sync(WORKSPACE, viewer(), account(), CONNECTION)).status).toBe("suppressed");
    expect(source.checksumCalls + source.pageCalls).toBe(readsBefore);
    expect(h.snapshots.current(WORKSPACE, account(), NOW()).status).toBe("none");
  });
});
