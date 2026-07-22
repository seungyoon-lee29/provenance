import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { ViewerContext } from "../src/shared";
import { brandReference } from "../src/shared/contracts/brands";
import {
  ProviderAuthorization,
  isPublicNetworkAddress,
  type AuthorizationCommitGuard,
  type CurrentAuthorizationState,
  type ProviderConnectionAuthorization,
  type ProviderRouteDefinition,
  type TransportExecutor,
} from "../src/platform/provider-transport";

function viewer(): ViewerContext {
  return {
    kind: "workspace",
    requestId: "request-1",
    workspaceReference: brandReference<string, "WorkspaceReference">("workspace-1"),
    accountReference: brandReference<string, "AccountReference">("account-1"),
    sessionReference: brandReference<string, "SessionReference">("session-1"),
    sessionGeneration: brandReference<string, "SessionGeneration">("session-generation-1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("account-epoch-1"),
    membershipRevision: brandReference<string, "MembershipRevision">("membership-1"),
  };
}

function authorization(overrides: Partial<ProviderConnectionAuthorization> = {}): ProviderConnectionAuthorization {
  return {
    purpose: "market_data",
    connectionReference: brandReference<string, "ProviderConnectionReference">("connection-1"),
    workspaceReference: brandReference<string, "WorkspaceReference">("workspace-1"),
    provider: "kis",
    environment: "paper",
    capability: "basic_quotes",
    credentialVersion: brandReference<string, "CredentialVersion">("credential-v1"),
    credentialGeneration: brandReference<string, "CredentialGeneration">("generation-1"),
    lifecycleFence: brandReference<string, "ConnectionLifecycleFence">("fence-1"),
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    allowedRouteIds: ["quote"],
    ...overrides,
  };
}

function route(overrides: Partial<ProviderRouteDefinition> = {}): ProviderRouteDefinition {
  return {
    id: "quote",
    provider: "kis",
    origin: "https://api.provider.example",
    path: "/v1/quote",
    method: "POST",
    environment: "paper",
    capability: "basic_quotes",
    requestSchema: z.strictObject({ symbol: z.string().min(1) }),
    responseSchema: z.strictObject({ price: z.number() }),
    allowedAuthorizationHeaders: ["authorization"],
    maxResponseBytes: 65_536,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function setup(options: Readonly<{
  route?: ProviderRouteDefinition;
  routes?: readonly ProviderRouteDefinition[];
  executor?: TransportExecutor;
  resolve?: () => Promise<readonly string[]>;
  headers?: () => Promise<Readonly<Record<string, string>>>;
  grant?: ProviderConnectionAuthorization;
  commitGuard?: AuthorizationCommitGuard;
}> = {}) {
  const grant = options.grant ?? authorization();
  let state: CurrentAuthorizationState = {
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
    sessionGeneration: brandReference<string, "SessionGeneration">("session-generation-1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("account-epoch-1"),
    membershipRevision: brandReference<string, "MembershipRevision">("membership-1"),
  };
  const executor = options.executor ?? vi.fn(async () => ({ price: 101 }));
  const commitGuard: AuthorizationCommitGuard = options.commitGuard ?? {
    async commitWhileCurrent(_authorization, currentViewer, value, persist) {
      if (state.connectionState !== "verified"
        || state.sessionGeneration !== currentViewer.sessionGeneration
        || state.accountAuthorizationEpoch !== currentViewer.accountAuthorizationEpoch
        || state.membershipRevision !== currentViewer.membershipRevision) {
        throw new Error("provider authorization is stale");
      }
      return persist(value);
    },
  };
  const providerAuthorization = new ProviderAuthorization(
    options.routes ?? [options.route ?? route()],
    async () => grant,
    async () => state,
    options.headers ?? (async () => ({ authorization: "Bearer sentinel" })),
    commitGuard,
    options.resolve ?? (async () => ["8.8.8.8"]),
    executor,
    () => new Date("2029-01-01T00:00:00.000Z"),
  );
  return { grant, providerAuthorization, executor, setState: (next: CurrentAuthorizationState) => { state = next; }, getState: () => state };
}

describe("AuthorizedTransport", () => {
  it("uses only the registered route, internal headers, no redirects, and a guarded commit", async () => {
    const fixture = setup();
    const transport = await fixture.providerAuthorization.authorize(fixture.grant.connectionReference, "market_data", viewer());
    const result = await transport.execute("quote", { symbol: "AAPL" });
    expect(fixture.executor).toHaveBeenCalledWith({
      url: "https://api.provider.example/v1/quote",
      method: "POST",
      headers: { authorization: "Bearer sentinel", "content-type": "application/json" },
      body: JSON.stringify({ symbol: "AAPL" }),
      redirect: "error",
      maxResponseBytes: 65_536,
      resolvedAddresses: ["8.8.8.8"],
      timeoutMs: 5_000,
    });
    const persist = vi.fn(async (value: unknown) => value);
    await expect(result.commit(persist)).resolves.toEqual({ price: 101 });
    await expect(result.commit(persist)).rejects.toThrow("already been committed");
  });

  it("rejects SSRF before resolving credentials or calling the executor", async () => {
    const headers = vi.fn(async () => ({ authorization: "Bearer sentinel" }));
    const fixture = setup({ resolve: async () => ["169.254.169.254"], headers });
    const transport = await fixture.providerAuthorization.authorize(fixture.grant.connectionReference, "market_data", viewer());
    await expect(transport.execute("quote", { symbol: "AAPL" })).rejects.toThrow("forbidden network");
    expect(headers).not.toHaveBeenCalled();
    expect(fixture.executor).not.toHaveBeenCalled();
  });

  it("rejects a forbidden route, mismatched live route, and invalid request with zero provider calls", async () => {
    const fixture = setup();
    const transport = await fixture.providerAuthorization.authorize(fixture.grant.connectionReference, "market_data", viewer());
    await expect(transport.execute("submit-order", {})).rejects.toThrow("not authorized");
    await expect(transport.execute("quote", { symbol: "" })).rejects.toThrow();
    expect(fixture.executor).not.toHaveBeenCalled();

    const liveFixture = setup({ route: route({ environment: "live" }) });
    const paperTransport = await liveFixture.providerAuthorization.authorize(liveFixture.grant.connectionReference, "market_data", viewer());
    await expect(paperTransport.execute("quote", { symbol: "AAPL" })).rejects.toThrow("does not match");
    expect(liveFixture.executor).not.toHaveBeenCalled();
  });

  it("rejects stale generation before dispatch", async () => {
    const fixture = setup();
    const transport = await fixture.providerAuthorization.authorize(fixture.grant.connectionReference, "market_data", viewer());
    fixture.setState({ ...fixture.getState(), credentialGeneration: brandReference<string, "CredentialGeneration">("generation-2") });
    await expect(transport.execute("quote", { symbol: "AAPL" })).rejects.toThrow("stale");
    expect(fixture.executor).not.toHaveBeenCalled();
  });

  it("rejects a fence change after dispatch and before returning a result", async () => {
    let fixture: ReturnType<typeof setup>;
    const executor = vi.fn(async () => {
      fixture.setState({ ...fixture.getState(), lifecycleFence: brandReference<string, "ConnectionLifecycleFence">("fence-2") });
      return { price: 101 };
    });
    fixture = setup({ executor });
    const transport = await fixture.providerAuthorization.authorize(fixture.grant.connectionReference, "market_data", viewer());
    await expect(transport.execute("quote", { symbol: "AAPL" })).rejects.toThrow("stale");
    expect(executor).toHaveBeenCalledOnce();
  });

  it("rejects a viewer epoch change at the late commit gate", async () => {
    const fixture = setup();
    const transport = await fixture.providerAuthorization.authorize(fixture.grant.connectionReference, "market_data", viewer());
    const result = await transport.execute("quote", { symbol: "AAPL" });
    fixture.setState({ ...fixture.getState(), accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("account-epoch-2") });
    const persist = vi.fn(async () => "persisted");
    await expect(result.commit(persist)).rejects.toThrow("stale");
    expect(persist).not.toHaveBeenCalled();
  });

  it("rejects unexpected credential headers before dispatch", async () => {
    const fixture = setup({ headers: async () => ({ authorization: "Bearer sentinel", "x-forwarded-host": "attacker" }) });
    const transport = await fixture.providerAuthorization.authorize(fixture.grant.connectionReference, "market_data", viewer());
    await expect(transport.execute("quote", { symbol: "AAPL" })).rejects.toThrow("forbidden authorization header");
    expect(fixture.executor).not.toHaveBeenCalled();
  });

  it("normalizes executor and response failures without leaking provider data", async () => {
    const failing = setup({ executor: async () => { throw new Error("provider-secret-sentinel"); } });
    const failingTransport = await failing.providerAuthorization.authorize(failing.grant.connectionReference, "market_data", viewer());
    await expect(failingTransport.execute("quote", { symbol: "AAPL" })).rejects.toThrow("provider transport failed");
    try {
      await failingTransport.execute("quote", { symbol: "AAPL" });
    } catch (error) {
      expect(String(error)).not.toContain("provider-secret-sentinel");
    }
    const malformed = setup({ executor: async () => ({ rawProviderPayload: "sentinel" }) });
    const malformedTransport = await malformed.providerAuthorization.authorize(malformed.grant.connectionReference, "market_data", viewer());
    await expect(malformedTransport.execute("quote", { symbol: "AAPL" })).rejects.toThrow("provider response does not match");
  });

  it("rejects dangerous route authorization headers at registry construction", () => {
    expect(() => setup({ route: route({ allowedAuthorizationHeaders: ["host"] }) })).toThrow("forbidden authorization header");
    expect(() => setup({ route: route({ allowedAuthorizationHeaders: ["Authorization", "authorization"] }) })).toThrow("forbidden authorization header");
  });

  it("rejects guest, wrong purpose, wrong workspace, and expired grants", async () => {
    const fixture = setup();
    await expect(fixture.providerAuthorization.authorize(fixture.grant.connectionReference, "market_data", { kind: "guest", requestId: "guest" })).rejects.toThrow("workspace viewer");
    await expect(fixture.providerAuthorization.authorize(fixture.grant.connectionReference, "paper_execution", viewer())).rejects.toThrow("purpose mismatch");
    const otherViewer = { ...viewer(), workspaceReference: brandReference<string, "WorkspaceReference">("workspace-2") };
    await expect(fixture.providerAuthorization.authorize(fixture.grant.connectionReference, "market_data", otherViewer)).rejects.toThrow("workspace mismatch");
    const expired = setup({ grant: authorization({ expiresAt: new Date("2028-01-01T00:00:00.000Z") }) });
    await expect(expired.providerAuthorization.authorize(expired.grant.connectionReference, "market_data", viewer())).rejects.toThrow("expired");
    expect(fixture.executor).not.toHaveBeenCalled();
  });

  it("rejects an authoritative grant for a different connection", async () => {
    const requested = authorization().connectionReference;
    const fixture = setup({ grant: authorization({ connectionReference: brandReference<string, "ProviderConnectionReference">("connection-2") }) });
    await expect(fixture.providerAuthorization.authorize(requested, "market_data", viewer())).rejects.toThrow("connection mismatch");
    expect(fixture.executor).not.toHaveBeenCalled();
  });

  it("rejects a duplicate current route set that hides a withdrawn route", async () => {
    const grant = authorization({ allowedRouteIds: ["quote", "order"] });
    const fixture = setup({
      grant,
      routes: [route(), route({ id: "order", path: "/v1/order" })],
    });
    const transport = await fixture.providerAuthorization.authorize(grant.connectionReference, "market_data", viewer());
    fixture.setState({ ...fixture.getState(), allowedRouteIds: ["quote", "quote"] });
    await expect(transport.execute("quote", { symbol: "AAPL" })).rejects.toThrow("stale");
    expect(fixture.executor).not.toHaveBeenCalled();
  });
});

describe("provider network policy", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "fe80::1", "192.0.2.1", "2001:db8::1", "2001::1", "2002:7f00:1::"])("blocks %s", (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public %s", (address) => {
    expect(isPublicNetworkAddress(address)).toBe(true);
  });
});
