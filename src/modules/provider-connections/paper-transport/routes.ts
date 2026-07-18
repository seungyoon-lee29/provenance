import { z } from "zod";

import type { ProviderRouteDefinition } from "../../../platform/provider-transport";

/**
 * F9 paper-order route allowlist (spec §9, SEC-04; ADR A03).
 *
 * Exactly four operations exist — submit, lookup, status, cancel — all bound
 * to the paper environment and the `paper_order` capability. Live Trading has
 * NO route here (and none anywhere else): a live submit is not a rejected
 * request, it is an unregistered operation, so the registry count for live is
 * structurally zero (§9 "black-box 요청은 side effect 0인 404/405").
 */

export const PAPER_ORDER_PROVIDER = "scripted-broker";
export const PAPER_ORDER_CAPABILITY = "paper_order";
export const PAPER_ORDER_PURPOSE = "paper_order";

export const PAPER_ORDER_ROUTE_IDS = {
  submit: "paper-order.submit",
  lookup: "paper-order.lookup",
  status: "paper-order.status",
  cancel: "paper-order.cancel",
} as const;

const money = z.strictObject({ amount: z.number().positive(), currency: z.string().min(1) });

const submitRequest = z.strictObject({
  clientOrder: z.string().min(1),
  instrument: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  quantity: z.number().int().positive(),
  limitPrice: money,
  timeInForce: z.enum(["DAY", "GTC"]),
});

const orderFact = z.strictObject({
  state: z.enum(["accepted", "rejected", "cancel_confirmed", "cancel_rejected"]),
  externalOrder: z.string().min(1),
  externalIdentity: z.string().min(1),
  revision: z.number().int().positive(),
});

const submitResponse = orderFact;
const lookupRequest = z.strictObject({ clientOrder: z.string().min(1) });
const lookupResponse = z.union([z.strictObject({ found: z.literal(false) }), z.strictObject({ found: z.literal(true), fact: orderFact })]);
const cancelRequest = z.strictObject({ clientOrder: z.string().min(1) });
const cancelResponse = orderFact;

export function paperOrderRoutes(origin = "https://broker-paper.example"): readonly ProviderRouteDefinition[] {
  const common = {
    provider: PAPER_ORDER_PROVIDER,
    origin,
    method: "POST" as const,
    environment: "paper" as const,
    capability: PAPER_ORDER_CAPABILITY,
    allowedAuthorizationHeaders: ["authorization"],
    maxResponseBytes: 65_536,
    timeoutMs: 5_000,
  };
  return [
    { ...common, id: PAPER_ORDER_ROUTE_IDS.submit, path: "/v1/paper/orders", requestSchema: submitRequest, responseSchema: submitResponse },
    { ...common, id: PAPER_ORDER_ROUTE_IDS.lookup, path: "/v1/paper/orders/lookup", requestSchema: lookupRequest, responseSchema: lookupResponse },
    { ...common, id: PAPER_ORDER_ROUTE_IDS.status, path: "/v1/paper/orders/status", requestSchema: lookupRequest, responseSchema: lookupResponse },
    { ...common, id: PAPER_ORDER_ROUTE_IDS.cancel, path: "/v1/paper/orders/cancel", requestSchema: cancelRequest, responseSchema: cancelResponse },
  ];
}
