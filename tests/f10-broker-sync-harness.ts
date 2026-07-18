import { brandReference } from "../src/shared/contracts/brands";
import type { ProviderConnectionReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import {
  ProviderAuthorization,
  type AuthorizationCommitGuard,
  type CurrentAuthorizationState,
  type ProviderConnectionAuthorization,
  type TransportExecutor,
} from "../src/platform/provider-transport";
import {
  brokerReadRoutes,
  BROKER_READ_CAPABILITY,
  BROKER_READ_PROVIDER,
  BROKER_READ_PURPOSE,
  BROKER_READ_ROUTE_IDS,
} from "../src/modules/provider-connections/read-transport/routes";
import type { BrokerReadWireEvent } from "../src/modules/provider-connections/read-transport/routes";
import { BrokerReadTransport } from "../src/modules/provider-connections/read-transport/broker-read-transport";
import { BrokerSyncEventStore } from "../src/modules/actual-portfolio/broker-sync/event-store";
import { BrokerSnapshotStore, foldComponentChecksum } from "../src/modules/actual-portfolio/broker-sync/snapshot";
import { BrokerSyncCursorStore, BrokerSyncWorker } from "../src/modules/actual-portfolio/broker-sync/sync-worker";
import type { BrokerComponentKey, BrokerSyncAccountReference } from "../src/modules/actual-portfolio/broker-sync/contracts";

export const WORKSPACE = "workspace:a";
export const CONNECTION = brandReference<string, "ProviderConnectionReference">("conn-scripted-read") as ProviderConnectionReference;

export function viewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-1",
    workspaceReference: brandReference<string, "WorkspaceReference">(WORKSPACE),
    accountReference: brandReference<string, "AccountReference">("account:a"),
    sessionReference: brandReference<string, "SessionReference">("session:a"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
  };
}

export function account(): BrokerSyncAccountReference {
  return brandReference<string, "BrokerSyncAccountReference">("sync-acct-1") as BrokerSyncAccountReference;
}

export type WireLineage = { externalAccountIdentity: string; verifiedFingerprint: string; providerDataEpoch: number };
export type WirePage = { events: BrokerReadWireEvent[]; checksum: string; asOf: string };

export function positionWire(entity: string, signedQuantity: number, revision = 1, extra: Partial<BrokerReadWireEvent> = {}): BrokerReadWireEvent {
  return { entity, kind: "position", externalIdentity: `${entity}-${revision}`, revision, asOf: "2026-07-19T00:00:00Z", body: { signedQuantity, currency: "USD" }, ...extra };
}
export function cashWire(currency: string, balance: number, revision = 1): BrokerReadWireEvent {
  return { entity: currency, kind: "cash_balance", externalIdentity: `${currency}-${revision}`, revision, asOf: "2026-07-19T00:00:00Z", body: { balance, currency } };
}

/**
 * Deterministic scripted broker READ source behind the pinned TransportExecutor
 * seam (network-off, §12.2). Serves a checksum/manifest and paged component
 * reads; knobs inject cursor reset, gap, and checksum divergence.
 */
export class ScriptedBrokerReadSource {
  lineage: WireLineage = { externalAccountIdentity: "ext-acct-1", verifiedFingerprint: "fp-1", providerDataEpoch: 1 };
  snapshotAsOf = "2026-07-19T00:00:00Z";
  maxComponentSkewMs = 1_000;
  readonly #pages = new Map<BrokerComponentKey, WirePage[]>();
  readonly #pageCountOverride = new Map<BrokerComponentKey, number>();
  readonly #checksumOverride = new Map<BrokerComponentKey, string>();
  /** When set, the component's page N is reported with pageIndex 0 (a mid-stream cursor reset). */
  resetCursor: { component: BrokerComponentKey; atCursor: string } | undefined;
  checksumCalls = 0;
  pageCalls = 0;

  set(component: BrokerComponentKey, pages: WirePage[]): this {
    this.#pages.set(component, pages);
    return this;
  }
  overridePageCount(component: BrokerComponentKey, count: number): this {
    this.#pageCountOverride.set(component, count);
    return this;
  }
  overrideChecksum(component: BrokerComponentKey, checksum: string): this {
    this.#checksumOverride.set(component, checksum);
    return this;
  }

  #pagesFor(component: BrokerComponentKey): WirePage[] {
    return this.#pages.get(component) ?? [];
  }

  #manifest() {
    const components: BrokerComponentKey[] = ["positions", "cash", "activity"];
    return {
      snapshotAsOf: this.snapshotAsOf,
      maxComponentSkewMs: this.maxComponentSkewMs,
      components: components.map((key) => {
        const pages = this.#pagesFor(key);
        const pageCount = this.#pageCountOverride.get(key) ?? pages.length;
        const checksum = this.#checksumOverride.get(key)
          ?? foldComponentChecksum(pages.map((page, index) => ({ pageIndex: index, checksum: page.checksum })));
        return { key, pageCount, checksum };
      }),
    };
  }

  executor: TransportExecutor = async (request) => {
    if (request.url.endsWith("/v1/broker/checksum")) {
      this.checksumCalls += 1;
      return { lineage: this.lineage, manifest: this.#manifest() };
    }
    this.pageCalls += 1;
    const body = JSON.parse(request.body ?? "{}") as { account: string; component: BrokerComponentKey; cursor?: string };
    const pages = this.#pagesFor(body.component);
    const index = body.cursor === undefined ? 0 : Number(body.cursor);
    const page = pages[index];
    if (page === undefined) throw new Error(`no scripted page ${index} for ${body.component}`);
    const reportedIndex = this.resetCursor && this.resetCursor.component === body.component && this.resetCursor.atCursor === body.cursor ? 0 : index;
    return {
      lineage: this.lineage,
      manifest: this.#manifest(),
      component: body.component,
      pageIndex: reportedIndex,
      isLastPage: index === pages.length - 1,
      checksum: page.checksum,
      asOf: page.asOf,
      events: page.events,
      ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}),
    };
  };
}

export function makeWorker(source: ScriptedBrokerReadSource, now: () => Date = () => new Date("2026-07-19T00:00:00.000Z")) {
  const grant: ProviderConnectionAuthorization = {
    purpose: BROKER_READ_PURPOSE,
    connectionReference: CONNECTION,
    workspaceReference: brandReference<string, "WorkspaceReference">(WORKSPACE),
    provider: BROKER_READ_PROVIDER,
    environment: "live",
    capability: BROKER_READ_CAPABILITY,
    credentialVersion: brandReference<string, "CredentialVersion">("v1"),
    credentialGeneration: brandReference<string, "CredentialGeneration">("gen-1"),
    lifecycleFence: brandReference<string, "ConnectionLifecycleFence">("fence-1"),
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    allowedRouteIds: Object.values(BROKER_READ_ROUTE_IDS),
  };
  const state: { current: CurrentAuthorizationState } = {
    current: {
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
    },
  };
  const commitGuard: AuthorizationCommitGuard = {
    async commitWhileCurrent(_authorization, _viewer, value, persist) {
      if (state.current.connectionState !== "verified") throw new Error("provider authorization is stale");
      return persist(value);
    },
  };
  const providerAuthorization = new ProviderAuthorization(
    brokerReadRoutes(),
    async () => grant,
    async () => state.current,
    async () => ({ authorization: "Bearer sentinel" }),
    commitGuard,
    async () => ["8.8.8.8"],
    source.executor,
    now,
  );
  const transport = new BrokerReadTransport({ authorization: providerAuthorization });
  const events = new BrokerSyncEventStore();
  const snapshots = new BrokerSnapshotStore();
  const cursors = new BrokerSyncCursorStore();
  const deps = { transport, events, snapshots, cursors, now };
  return {
    events,
    snapshots,
    cursors,
    worker: new BrokerSyncWorker(deps),
    /** A fresh worker over the same durable stores — models a process restart. */
    restartedWorker: () => new BrokerSyncWorker(deps),
    revoke: () => {
      state.current = { ...state.current, connectionState: "revoked" };
    },
  };
}
