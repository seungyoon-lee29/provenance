import { describe, expect, it } from "vitest";

import {
  createDartFilingsInformation,
  type DartConfig,
  type DartHttp,
} from "../src/modules/financial-information/data/dart-filings-information";

// Opt-in contract test (ticket 33-c). Hits the REAL Open DART list API with the operator's key.
// Gated on BOTH the flag and a configured key — without a key it skips (not_run posture), never
// fails vacuously. The key is read from the environment and never printed or asserted on.
//   RUN: DART_CONTRACT=1 node --env-file=.env.local --import tsx node_modules/.bin/vitest run tests/dart-filings-information.contract.test.ts
const KEY = process.env.DART_API_KEY?.trim() ?? "";
const RUN = process.env.DART_CONTRACT === "1" && KEY.length > 0;

const realHttp: DartHttp = async (req) => {
  const res = await fetch(req.url);
  return { status: res.status, json: await res.json().catch(() => ({})) };
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

describe.skipIf(!RUN)("DART filings — live opt-in contract (real opendart.fss.or.kr)", () => {
  it("returns a live available filing list with public provenance and no key leakage", async () => {
    const config: DartConfig = {
      base: "https://opendart.fss.or.kr",
      apiKey: KEY,
      licenseValidUntil: "2099-01-01T00:00:00.000Z",
    };
    const info = createDartFilingsInformation({ http: realHttp, clock: realClock, config });

    const outcome = await info.readRecent({ kind: "guest", requestId: "contract-1" });

    // 주말/새벽엔 당일 목록이 비어 no_data일 수 있다 — 그것도 정직한 계약 결과다.
    expect(["available", "unavailable"]).toContain(outcome.status);
    if (outcome.status === "available") {
      if (outcome.value.kind !== "filing") throw new Error("unexpected evidence kind");
      expect(outcome.value.filings.length).toBeGreaterThan(0);
      expect(outcome.value.filings[0]?.accession).toMatch(/^\d+$/);
      expect(outcome.licenseScope.audience).toBe("public");
    }
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  }, 30_000);
});
