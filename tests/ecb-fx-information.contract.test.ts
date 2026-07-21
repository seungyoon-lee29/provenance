import { describe, expect, it } from "vitest";

import {
  createEcbFxInformation,
  type EcbConfig,
  type EcbHttp,
} from "../src/modules/financial-information/data/ecb-fx-information";
import type { MarketQuery } from "../src/modules/financial-information/data/contracts";

// Opt-in contract test (ticket 32-a). Hits the REAL ECB SDMX API — keyless, but still network, so
// the network-off unit lane leaves ECB_CONTRACT unset and the block skips deterministically.
//   RUN: ECB_CONTRACT=1 npx vitest run tests/ecb-fx-information.contract.test.ts
const RUN = process.env.ECB_CONTRACT === "1";

const CONFIG: EcbConfig = {
  base: "https://data-api.ecb.europa.eu",
  licenseValidUntil: "2099-01-01T00:00:00.000Z",
};

const realHttp: EcbHttp = async (req) => {
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

const query: MarketQuery = { kind: "FinancialQuery", symbol: "USDKRW", purpose: "public_display", requestRevision: "r0" };

describe.skipIf(!RUN)("ECB FX cross — live opt-in contract (real data-api.ecb.europa.eu)", () => {
  it("returns a live available USD/KRW indicative cross with public provenance", async () => {
    const info = createEcbFxInformation({ http: realHttp, clock: realClock, config: CONFIG });

    const outcome = await info.read(query, { kind: "guest", requestId: "contract-1" }).result;

    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    // A plausible USD/KRW: parse produced a real cross, not a stray column.
    expect(outcome.value.last).toBeGreaterThan(500);
    expect(outcome.value.last).toBeLessThan(5_000);
    expect(outcome.value.currency).toBe("KRW");
    expect(outcome.value.priceBasis).toBe("indicative");
    expect(outcome.provider).toBe("ecb");
    expect(outcome.licenseScope.audience).toBe("public");
    // asOf is a real recent business date: bounded below and never in the future.
    expect(Date.parse(outcome.asOf)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(outcome.asOf)).toBeGreaterThan(Date.now() - 10 * 86_400_000);
  }, 30_000);
});
