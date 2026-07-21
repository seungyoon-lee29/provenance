import "server-only";

import { DATA_DEADLINE_MS } from "@/modules/financial-information/data/deadline";
import {
  createDartFilingsInformation,
  createDisabledFilingsInformation,
} from "@/modules/financial-information/data/dart-filings-information";
import type { DartHttp, FilingsInformation } from "@/modules/financial-information/data/dart-filings-information";
import { withTreasuryCache } from "@/modules/financial-information/data/treasury-market-information";
import { loadRuntimeConfig } from "./runtime-policy";

// Guest-track filings singleton (ticket 33-b). Same opt-in posture as public-market-server
// (PUBLIC_MARKET_ENABLED) plus a configured DART_API_KEY — without both, zero external egress.
// The key flows env → request URL only; it never enters an outcome, log, or reference.

const DART_BASE = "https://opendart.fss.or.kr";

// Spec §5.1 "DART latest list" soft 5분 — enforced as a transport TTL (each served list is at most
// 5 minutes old) rather than by aging a stored value; also bounds anonymous upstream amplification.
const CACHE_TTL_MS = 5 * 60_000;

const MAX_RESPONSE_BYTES = 5_000_000;

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

function fetchDartHttp(): DartHttp {
  const text = withTreasuryCache(
    async (req) => {
      // redirect: "error" — a redirected feed is foreign content (matches the public-market transport).
      const res = await fetch(req.url, { signal: AbortSignal.timeout(DATA_DEADLINE_MS), redirect: "error" });
      const declaredLength = Number(res.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        return { status: 502, body: "" };
      }
      return { status: res.status, body: await res.text().catch(() => "") };
    },
    () => Date.now(),
    CACHE_TTL_MS,
  );
  return async (req) => {
    const res = await text({ url: req.url });
    try {
      return { status: res.status, json: JSON.parse(res.body) as unknown };
    } catch {
      return { status: res.status, json: {} };
    }
  };
}

const globalStore = globalThis as unknown as { __ftPublicFilings?: FilingsInformation };

function build(): FilingsInformation {
  const config = loadRuntimeConfig(process.env);
  const apiKey = process.env.DART_API_KEY?.trim() ?? "";
  if (!config.publicMarketEnabled || apiKey.length === 0) return createDisabledFilingsInformation();
  return createDartFilingsInformation({
    http: fetchDartHttp(),
    clock: realClock,
    config: { base: DART_BASE, apiKey, licenseValidUntil: "2099-01-01T00:00:00.000Z" },
  });
}

export function publicFilingsServer(): FilingsInformation {
  if (globalStore.__ftPublicFilings !== undefined) return globalStore.__ftPublicFilings;
  globalStore.__ftPublicFilings = build();
  return globalStore.__ftPublicFilings;
}
