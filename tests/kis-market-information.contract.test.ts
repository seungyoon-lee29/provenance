import { describe, expect, it } from "vitest";

import {
  createKisMarketInformation,
  type KisConfig,
  type KisHttp,
} from "../src/modules/financial-information/data/kis-market-information";
import type { MarketQuery, ObservationExpiryPolicy } from "../src/modules/financial-information/data/contracts";
import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "../src/shared/contracts/viewer-context";

// Opt-in sandbox contract test (ticket 24 acceptance; map.md line 17 "별도 contract test").
// Hits REAL KIS 모의(:29443) with the owner's credentials — ready-for-human, needs network + creds.
// The network-off unit lane leaves KIS_CONTRACT unset, so the whole block skips deterministically.
//   RUN: KIS_CONTRACT=1 node --env-file=.env.local --import tsx node_modules/.bin/vitest run tests/kis-market-information.contract.test.ts
const RUN = process.env.KIS_CONTRACT === "1";

const OWNER = brandReference<string, "WorkspaceReference">("workspace:contract-owner");
// Lenient hard limit so the value surfaces regardless of session (off-hours it is a stale prev close,
// still an available observation) — the live assertion is "a KRW value comes back", not its freshness.
const POLICY: ObservationExpiryPolicy = { kind: "residual", declaredDelayMs: 900_000, softResidualMs: 900_000, hardResidualMs: 30 * 24 * 3_600_000 };

// Thin real transport — the IO boundary the network-off suite injects a stub for.
const realHttp: KisHttp = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: { ...req.headers }, body: req.body });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

function ownerViewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "contract-1",
    workspaceReference: OWNER,
    accountReference: brandReference<string, "AccountReference">("account:contract-owner"),
    sessionReference: brandReference<string, "SessionReference">("session:contract-owner"),
    sessionGeneration: brandReference<string, "SessionGeneration">("1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("1"),
    membershipRevision: brandReference<string, "MembershipRevision">("1"),
  };
}

const query: MarketQuery = { kind: "FinancialQuery", symbol: "005930", purpose: "personal_display", requestRevision: "r0" };

describe.skipIf(!RUN)("KIS market information — live opt-in contract (real :29443)", () => {
  it("returns a live available KRW observation for 삼성전자 (005930)", async () => {
    const config: KisConfig = {
      base: process.env.KIS_REST_BASE?.trim() || "https://openapivts.koreainvestment.com:29443",
      appkey: process.env.KIS_APP_KEY ?? "",
      appsecret: process.env.KIS_APP_SECRET ?? "",
      ownerWorkspaceReference: OWNER,
      policy: POLICY,
      licenseValidUntil: "2099-01-01T00:00:00.000Z",
    };
    const sleep = (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(signal.reason);
        });
      });
    const info = createKisMarketInformation({ http: realHttp, clock: { now: () => Date.now(), sleep }, config });

    const outcome = await info.read(query, ownerViewer()).result;

    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.currency).toBe("KRW");
    expect(Number.isFinite(outcome.value.last)).toBe(true);
    expect(outcome.value.last).toBeGreaterThan(0);
    expect(outcome.licenseScope.audience).toBe("personal");
  });
});
