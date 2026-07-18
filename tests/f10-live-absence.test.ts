import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BROKER_READ_CAPABILITY, brokerReadRoutes } from "../src/modules/provider-connections/read-transport/routes";

/**
 * F10 Live absence (spec §8 out-of-scope, SEC-04): Broker Sync only READS. There
 * is no order-mutation / Live-submit operation anywhere in the F10 subtree, so a
 * live submit is an unregistered operation, not a rejected request.
 */

const F10_SOURCES = [
  "src/modules/actual-portfolio/broker-sync/contracts.ts",
  "src/modules/actual-portfolio/broker-sync/event-store.ts",
  "src/modules/actual-portfolio/broker-sync/projection.ts",
  "src/modules/actual-portfolio/broker-sync/snapshot.ts",
  "src/modules/actual-portfolio/broker-sync/sync-worker.ts",
  "src/modules/actual-portfolio/broker-sync/broker-erasure.ts",
  "src/modules/provider-connections/read-transport/routes.ts",
  "src/modules/provider-connections/read-transport/broker-read-transport.ts",
];

describe("F10 Live Trading absence", () => {
  it("registers only read routes — no submit/cancel/order/mutation operation", () => {
    const routes = brokerReadRoutes();
    expect(routes).toHaveLength(4);
    for (const route of routes) {
      expect(route.capability).toBe(BROKER_READ_CAPABILITY);
      expect(route.environment).toBe("live");
      expect(route.method).toBe("POST");
      for (const forbidden of ["submit", "cancel", "order", "mutate", "write"]) {
        expect(route.id.toLowerCase()).not.toContain(forbidden);
        expect(route.path.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it("does not import the paper-trading broker execution subtree or an execution port", () => {
    for (const relativePath of F10_SOURCES) {
      const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
      expect(source).not.toContain("paper-trading/broker");
      expect(source).not.toContain("paper-transport");
      expect(source).not.toContain("BrokerPaperExecution");
      expect(source).not.toContain("PAPER_ORDER");
    }
  });
});
