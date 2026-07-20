import "server-only";

import { brandReference } from "@/shared/contracts/brands";
import type { WorkspaceReference } from "@/shared/contracts/brands";
import { DATA_DEADLINE_MS } from "@/modules/financial-information/data/deadline";
import type { KisConfig, KisHttp } from "@/modules/financial-information/data/kis-market-information";
import type { ObservationExpiryPolicy } from "@/modules/financial-information/data/contracts";
import { assembleMarketInformation } from "./market-assembly";
import type { MarketAssembly } from "./market-assembly";
import { loadRuntimeConfig } from "./runtime-policy";

// Non-chart market data singleton (ticket 26-a). Mirrors identity-server: a globalThis-anchored
// in-memory singleton so every route bundle shares one instance (and one token cache).

// In-session realtime (declaredDelay 0); off-session the previous close stays a stale-but-visible
// value for a few days rather than vanishing (the adapter's KRX-session logic sets its as-of/basis).
const KIS_MARKET_POLICY: ObservationExpiryPolicy = {
  kind: "residual",
  declaredDelayMs: 0,
  softResidualMs: 15 * 60_000,
  hardResidualMs: 3 * 24 * 3_600_000,
};

const realMarketClock = {
  now: () => Date.now(),
  sleep: (durationMs: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(resolve, durationMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    }),
};

// The real IO boundary: fetch with its own deadline so a hung socket is aborted (defense-in-depth
// with the adapter's withDeadline). Secrets flow env → header only; never logged, never returned.
// KIS quote/token responses are a few KB; cap the body so a rogue/oversized response can't exhaust
// memory. ponytail: best-effort Content-Length guard — the base is pinned to KIS so an attacker can't
// point us at a huge-body server; a chunked response without Content-Length is not capped (residual).
const MAX_RESPONSE_BYTES = 1_000_000;

function fetchKisHttp(): KisHttp {
  return async (req) => {
    const res = await fetch(req.url, {
      method: req.method,
      headers: { ...req.headers },
      body: req.body,
      signal: AbortSignal.timeout(DATA_DEADLINE_MS),
    });
    const declaredLength = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      return { status: 502, json: {} };
    }
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
}

export type MarketSingleton = MarketAssembly;

const globalStore = globalThis as unknown as { __ftMarket?: MarketSingleton };

function build(): MarketSingleton {
  const config = loadRuntimeConfig(process.env);
  if (config.kisMarketEnabled) {
    const kisConfig: KisConfig = {
      // Pinned to an official KIS origin by loadRuntimeConfig (never an arbitrary host) — the token
      // POST carries appkey/appsecret, so the destination must be allowlisted, not env-arbitrary.
      base: config.kisMarketBase,
      // Guaranteed present by kisMarketEnabled (creds + single_owner + owner workspace + contract).
      appkey: process.env.KIS_APP_KEY as string,
      appsecret: process.env.KIS_APP_SECRET as string,
      ownerWorkspaceReference: brandReference<string, "WorkspaceReference">(config.localProviderOwnerWorkspaceId as string) as WorkspaceReference,
      policy: KIS_MARKET_POLICY,
      licenseValidUntil: new Date(Date.now() + 365 * 24 * 3_600_000).toISOString(),
    };
    return assembleMarketInformation("kis", { clock: realMarketClock, kis: { http: fetchKisHttp(), config: kisConfig } });
  }
  return assembleMarketInformation("scripted", { clock: realMarketClock });
}

export function marketServer(): MarketSingleton {
  if (globalStore.__ftMarket !== undefined) return globalStore.__ftMarket;
  globalStore.__ftMarket = build();
  return globalStore.__ftMarket;
}
