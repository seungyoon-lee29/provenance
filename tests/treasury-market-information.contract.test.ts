import { describe, expect, it } from "vitest";

import {
  createPublicMarketInformation,
  type TreasuryConfig,
  type TreasuryHttp,
} from "../src/modules/financial-information/data/treasury-market-information";
import type { MarketQuery } from "../src/modules/financial-information/data/contracts";

// Opt-in contract test (ticket 28 acceptance; map.md line 17 "별도 contract test"). Hits the REAL
// treasury.gov XML feed — keyless and public domain, but still network, so the network-off unit
// lane leaves TREASURY_CONTRACT unset and the whole block skips deterministically.
//   RUN: TREASURY_CONTRACT=1 npx vitest run tests/treasury-market-information.contract.test.ts
// Runs the PRODUCTION freshness policy (spec §5.1 business-day publications): a healthy live feed
// always has at most one missed publication, so `available` is the honest expectation.
const RUN = process.env.TREASURY_CONTRACT === "1";

const CONFIG: TreasuryConfig = {
  base: "https://home.treasury.gov",
  licenseValidUntil: "2099-01-01T00:00:00.000Z",
};

const realHttp: TreasuryHttp = async (req) => {
  const res = await fetch(req.url);
  return { status: res.status, body: await res.text().catch(() => "") };
};

const realClock = {
  now: () => Date.now(),
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(signal.reason);
      });
    }),
};

const query: MarketQuery = { kind: "FinancialQuery", symbol: "UST10Y", purpose: "public_display", requestRevision: "r0" };

describe.skipIf(!RUN)("Treasury yield curve — live opt-in contract (real treasury.gov)", () => {
  it("returns a live available % observation for UST10Y with public provenance", async () => {
    const info = createPublicMarketInformation({ http: realHttp, clock: realClock, config: CONFIG });

    const outcome = await info.read(query, { kind: "guest", requestId: "contract-1" }).result;

    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    // A plausible 10Y par yield: the parse produced a real rate, not a stray field or NaN.
    expect(outcome.value.last).toBeGreaterThan(0);
    expect(outcome.value.last).toBeLessThan(20);
    expect(outcome.value.currency).toBe("%");
    expect(outcome.value.priceBasis).toBe("eod");
    expect(outcome.provider).toBe("treasury");
    expect(outcome.licenseScope.audience).toBe("public");
    expect(Number.isFinite(outcome.value.change)).toBe(true);
    // asOf is a real RECENT business date: bounded below (≤10 days old) and never in the future.
    expect(Date.parse(outcome.asOf)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(outcome.asOf)).toBeGreaterThan(Date.now() - 10 * 86_400_000);
  }, 30_000);
});
