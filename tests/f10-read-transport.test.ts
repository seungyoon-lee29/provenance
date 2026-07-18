import { describe, expect, it } from "vitest";

import { BROKER_READ_CAPABILITY, BROKER_READ_ROUTE_IDS, brokerReadRoutes } from "../src/modules/provider-connections/read-transport/routes";

describe("F10 broker read-only route allowlist (SEC-04, Live absence)", () => {
  it("registers exactly the four read routes, all live/broker_read/POST", () => {
    const routes = brokerReadRoutes();
    expect(routes.map((route) => route.id).sort()).toEqual([...Object.values(BROKER_READ_ROUTE_IDS)].sort());
    for (const route of routes) {
      expect(route.environment).toBe("live");
      expect(route.capability).toBe(BROKER_READ_CAPABILITY);
      expect(route.method).toBe("POST");
    }
  });

  it("registers no order-mutation / submit / cancel route (read-only proof)", () => {
    const ids = brokerReadRoutes().map((route) => route.id.toLowerCase());
    for (const forbidden of ["submit", "cancel", "order", "mutate", "write"]) {
      expect(ids.some((id) => id.includes(forbidden))).toBe(false);
    }
  });

  it("does not import the F9 paper-order transport subtree", async () => {
    const routesSource = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/modules/provider-connections/read-transport/routes.ts", import.meta.url), "utf8"));
    const portSource = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/modules/provider-connections/read-transport/broker-read-transport.ts", import.meta.url), "utf8"));
    expect(routesSource).not.toContain("paper-transport");
    expect(portSource).not.toContain("paper-transport");
  });
});
