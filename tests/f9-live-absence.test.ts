import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import {
  ProviderAuthorization,
  type CurrentAuthorizationState,
  type ProviderConnectionAuthorization,
} from "../src/platform/provider-transport";
import { paperOrderRoutes, PAPER_ORDER_ROUTE_IDS } from "../src/modules/provider-connections/paper-transport/routes";
import { viewer } from "./f9-broker-harness";

/**
 * §9/AT-08 + ticket AC: Live Trading is ABSENT, not rejected — zero registered
 * operations/capabilities, and a live-environment authorization cannot drive
 * the paper routes (provider call 0). The HTTP black-box 404/405 follows
 * structurally: Next.js returns 404 for any unregistered path, and no live
 * trading route file exists under src/app.
 */

describe("Live route absence (§9, SEC-04)", () => {
  it("registers exactly the four paper operations and nothing live", () => {
    const routes = paperOrderRoutes();
    expect(routes.map((route) => route.id).sort()).toEqual(Object.values(PAPER_ORDER_ROUTE_IDS).sort());
    for (const route of routes) {
      expect(route.environment).toBe("paper");
      expect(route.capability).toBe("paper_order");
      expect(`${route.id} ${route.path} ${route.origin}`.toLowerCase()).not.toContain("live");
    }
  });

  it("makes zero provider calls for a live-environment authorization against paper routes", async () => {
    const grant: ProviderConnectionAuthorization = {
      purpose: "paper_order",
      connectionReference: brandReference<string, "ProviderConnectionReference">("conn-live"),
      workspaceReference: brandReference<string, "WorkspaceReference">("workspace:a"),
      provider: "scripted-broker",
      environment: "live",
      capability: "paper_order",
      credentialVersion: brandReference<string, "CredentialVersion">("v1"),
      credentialGeneration: brandReference<string, "CredentialGeneration">("gen-1"),
      lifecycleFence: brandReference<string, "ConnectionLifecycleFence">("fence-1"),
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      allowedRouteIds: Object.values(PAPER_ORDER_ROUTE_IDS),
    };
    const state: CurrentAuthorizationState = {
      purpose: grant.purpose,
      connectionReference: grant.connectionReference,
      workspaceReference: grant.workspaceReference,
      provider: grant.provider,
      environment: grant.environment,
      capability: grant.capability,
      allowedRouteIds: grant.allowedRouteIds,
      connectionState: "verified",
      credentialVersion: grant.credentialVersion,
      credentialGeneration: grant.credentialGeneration,
      lifecycleFence: grant.lifecycleFence,
      sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
      accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
      membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
    };
    const executor = vi.fn(async () => ({}));
    const authorization = new ProviderAuthorization(
      paperOrderRoutes(),
      async () => grant,
      async () => state,
      async () => ({ authorization: "Bearer sentinel" }),
      { commitWhileCurrent: async (_a, _v, value, persist) => persist(value) },
      async () => ["8.8.8.8"],
      executor,
      () => new Date("2026-07-18T10:00:00.000Z"),
    );
    const transport = await authorization.authorize(grant.connectionReference, "paper_order", viewer());
    await expect(transport.execute(PAPER_ORDER_ROUTE_IDS.submit, { clientOrder: "c", instrument: "i", side: "buy", quantity: 1, limitPrice: { amount: 10, currency: "USD" }, timeInForce: "DAY" })).rejects.toThrow(
      "provider route does not match its authorization",
    );
    expect(executor).not.toHaveBeenCalled();
  });

  it("has no live trading surface under src/app (black-box requests 404 by construction)", () => {
    expect(existsSync("src/app/api/live")).toBe(false);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    const liveSegments = walk("src/app").filter((path) => /(^|\/)live(-|\/|\.)/i.test(path));
    expect(liveSegments).toEqual([]);
  });
});
