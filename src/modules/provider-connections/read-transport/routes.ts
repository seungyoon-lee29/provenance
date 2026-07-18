import { z } from "zod";

import type { ProviderRouteDefinition } from "../../../platform/provider-transport";

/**
 * F10 broker read-only route allowlist (spec §8, SEC-04; ADR A04).
 *
 * These routes only READ a real broker account (positions, cash, activity, and a
 * checksum/manifest audit). There is NO order-mutation or submit route here or
 * anywhere in this subtree — a live submit is an unregistered operation, so the
 * read registry proves Live Trading order transmission is structurally absent
 * (the F10 counterpart of F9's paper-only allowlist). The paper-order transport
 * subtree is never imported from here.
 */

export const BROKER_READ_PROVIDER = "scripted-broker-read";
export const BROKER_READ_CAPABILITY = "broker_read";
export const BROKER_READ_PURPOSE = "broker_read";

export const BROKER_READ_ROUTE_IDS = {
  positions: "broker-read.positions",
  cash: "broker-read.cash",
  activity: "broker-read.activity",
  checksum: "broker-read.checksum",
} as const;

export type BrokerReadComponent = "positions" | "cash" | "activity";

const sourceMoney = z.strictObject({ amount: z.number(), currency: z.string().min(1) });

const positionBody = z.strictObject({
  signedQuantity: z.number(),
  currency: z.string().min(1),
  sourceCostBasis: sourceMoney.optional(),
  unsupported: z.boolean().optional(),
  sourceType: z.string().optional(),
  sourceReference: z.string().optional(),
});
const cashBody = z.strictObject({ balance: z.number(), currency: z.string().min(1) });
const activityBody = z.strictObject({
  activityKind: z.string().min(1),
  occurredAt: z.string().min(1),
  signedCashAmount: sourceMoney.optional(),
  instrument: z.string().optional(),
  signedQuantity: z.number().optional(),
});

const wireEvent = z.strictObject({
  entity: z.string().min(1),
  kind: z.string().min(1),
  externalIdentity: z.string().min(1),
  revision: z.number().int().positive(),
  asOf: z.string().min(1),
  corrects: z.string().optional(),
  body: z.union([positionBody, cashBody, activityBody]),
});

const lineage = z.strictObject({
  externalAccountIdentity: z.string().min(1),
  verifiedFingerprint: z.string().min(1),
  providerDataEpoch: z.number().int().nonnegative(),
});

/** The manifest declares, per lineage snapshot, how many pages + which checksum each component owns. */
const manifest = z.strictObject({
  snapshotAsOf: z.string().min(1),
  maxComponentSkewMs: z.number().int().nonnegative(),
  components: z.array(z.strictObject({ key: z.enum(["positions", "cash", "activity"]), pageCount: z.number().int().nonnegative(), checksum: z.string().min(1) })),
});

const readRequest = z.strictObject({
  account: z.string().min(1),
  component: z.enum(["positions", "cash", "activity"]),
  cursor: z.string().optional(),
});

const readPage = z.strictObject({
  lineage,
  manifest,
  component: z.enum(["positions", "cash", "activity"]),
  pageIndex: z.number().int().nonnegative(),
  isLastPage: z.boolean(),
  checksum: z.string().min(1),
  asOf: z.string().min(1),
  events: z.array(wireEvent),
  nextCursor: z.string().optional(),
});

const checksumRequest = z.strictObject({ account: z.string().min(1) });
const checksumResponse = z.strictObject({ lineage, manifest });

export function brokerReadRoutes(origin = "https://broker-read.example"): readonly ProviderRouteDefinition[] {
  const common = {
    provider: BROKER_READ_PROVIDER,
    origin,
    method: "POST" as const,
    environment: "live" as const,
    capability: BROKER_READ_CAPABILITY,
    allowedAuthorizationHeaders: ["authorization"],
    maxResponseBytes: 262_144,
    timeoutMs: 30_000,
  };
  return [
    { ...common, id: BROKER_READ_ROUTE_IDS.positions, path: "/v1/broker/positions", requestSchema: readRequest, responseSchema: readPage },
    { ...common, id: BROKER_READ_ROUTE_IDS.cash, path: "/v1/broker/cash", requestSchema: readRequest, responseSchema: readPage },
    { ...common, id: BROKER_READ_ROUTE_IDS.activity, path: "/v1/broker/activity", requestSchema: readRequest, responseSchema: readPage },
    { ...common, id: BROKER_READ_ROUTE_IDS.checksum, path: "/v1/broker/checksum", requestSchema: checksumRequest, responseSchema: checksumResponse },
  ];
}

export type BrokerReadPageResponse = z.infer<typeof readPage>;
export type BrokerReadManifest = z.infer<typeof manifest>;
export type BrokerReadWireEvent = z.infer<typeof wireEvent>;
export type BrokerReadLineageWire = z.infer<typeof lineage>;
