import "server-only";

import { DATA_DEADLINE_MS } from "@/modules/financial-information/data/deadline";
import type { MarketInformation } from "@/modules/financial-information/data/contracts";
import {
  createDisabledPublicMarketInformation,
  createPublicMarketInformation,
  withTreasuryCache,
} from "@/modules/financial-information/data/treasury-market-information";
import type { TreasuryHttp } from "@/modules/financial-information/data/treasury-market-information";
import { loadRuntimeConfig } from "./runtime-policy";

// Public (guest-redistributable) market data singleton (ticket 28-b). Mirrors market-server but
// needs no credential: the Treasury feed is keyless public domain. Gated by
// PUBLIC_MARKET_TREASURY_ENABLED (rights.md — a real provider is called only on explicit opt-in;
// spec §12.2 — PR jobs deny external egress, so the default composition must attempt none).
// Kept separate from the personal KIS singleton — the two tracks never share a provider.

// The destination is a compile-time literal, not env-configurable: nothing secret flows out (keyless
// GET), and pinning removes the redirect-the-transport surface entirely (egress invariant, ticket 21).
const TREASURY_BASE = "https://home.treasury.gov";

// Yearly XML is ~210KB (ticket-27 probe); cap the body so an oversized response can't exhaust memory.
// ponytail: best-effort Content-Length guard, same residual as the KIS transport — the base is pinned
// to treasury.gov so an attacker can't point us at a huge-body server; chunked responses aren't capped.
const MAX_RESPONSE_BYTES = 5_000_000;

// One publication per business day: a 5-minute TTL bounds anonymous request amplification to the
// upstream while staying far fresher than the feed's own cadence.
const CACHE_TTL_MS = 5 * 60_000;

const realClock = {
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

function fetchTreasuryHttp(): TreasuryHttp {
  return async (req) => {
    // redirect: "error" — a redirected feed is foreign content, not Treasury data; the pinned
    // origin must be the final origin (matches the platform https-executor's no-redirect rule).
    const res = await fetch(req.url, { signal: AbortSignal.timeout(DATA_DEADLINE_MS), redirect: "error" });
    const declaredLength = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      return { status: 502, body: "" };
    }
    return { status: res.status, body: await res.text().catch(() => "") };
  };
}

const globalStore = globalThis as unknown as { __ftPublicMarket?: MarketInformation };

function build(): MarketInformation {
  const config = loadRuntimeConfig(process.env);
  if (!config.treasuryMarketEnabled) return createDisabledPublicMarketInformation();
  return createPublicMarketInformation({
    http: withTreasuryCache(fetchTreasuryHttp(), () => Date.now(), CACHE_TTL_MS),
    clock: realClock,
    config: { base: TREASURY_BASE, licenseValidUntil: "2099-01-01T00:00:00.000Z" },
  });
}

export function publicMarketServer(): MarketInformation {
  if (globalStore.__ftPublicMarket !== undefined) return globalStore.__ftPublicMarket;
  globalStore.__ftPublicMarket = build();
  return globalStore.__ftPublicMarket;
}
