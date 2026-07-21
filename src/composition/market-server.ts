import "server-only";

import { brandReference } from "@/shared/contracts/brands";
import type { WorkspaceReference } from "@/shared/contracts/brands";
import { DATA_DEADLINE_MS } from "@/modules/financial-information/data/deadline";
import type { KisConfig, KisHttp } from "@/modules/financial-information/data/kis-market-information";
import { withRequestSpacing } from "@/modules/financial-information/data/kis-market-information";
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
    // 간격은 문서가 아니라 실측으로 정했다(ticket 34, 모의 :29443에 8콜씩):
    //   500ms → 유량 초과, 700ms → 8콜 중 2건 EGW00201, 1100ms → 0건.
    // 즉 모의의 지속 한도는 초당 ~1건(순간 버스트만 2건)이다. 실전 계정(20건/초)으로 옮기면 base와
    // 함께 낮춘다. ponytail: 심볼이 8개를 넘는 화면은 이 간격만으로는 §11.3 10s를 넘기므로, 그때는
    // 간격을 더 줄이는 게 아니라 짧은 TTL 캐시/배치를 먼저 얹어야 한다(티켓 36).
    const http = withRequestSpacing(fetchKisHttp(), { minIntervalMs: 1_100, clock: realMarketClock });
    return assembleMarketInformation("kis", { clock: realMarketClock, kis: { http, config: kisConfig } });
  }
  return assembleMarketInformation("scripted", { clock: realMarketClock });
}

export function marketServer(): MarketSingleton {
  if (globalStore.__ftMarket !== undefined) return globalStore.__ftMarket;
  globalStore.__ftMarket = build();
  return globalStore.__ftMarket;
}
