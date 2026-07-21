import { describe, expect, it } from "vitest";

import {
  createKisMarketInformation,
  type KisConfig,
  type KisHttp,
} from "../src/modules/financial-information/data/kis-market-information";
import type { MarketQuery, ObservationExpiryPolicy } from "../src/modules/financial-information/data/contracts";
import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "../src/shared/contracts/viewer-context";

// Opt-in contract test (ticket 31-c). Hits REAL KIS 모의(:29443) with the owner's credentials to
// confirm the index TR/path/field assumptions (FHPUP02100000 · inquire-index-price · bstp_nmix_*).
//   RUN: KIS_CONTRACT=1 node --env-file=.env.local --import tsx node_modules/.bin/vitest run tests/kis-index-information.contract.test.ts
const RUN = process.env.KIS_CONTRACT === "1";

const OWNER = brandReference<string, "WorkspaceReference">("workspace:contract-owner");
// Lenient hard limit: off-session the index is a stale previous close — still an available value.
const POLICY: ObservationExpiryPolicy = { kind: "residual", declaredDelayMs: 900_000, softResidualMs: 900_000, hardResidualMs: 30 * 24 * 3_600_000 };

const realHttp: KisHttp = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: { ...req.headers }, body: req.body });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

function ownerViewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "contract-idx-1",
    workspaceReference: OWNER,
    accountReference: brandReference<string, "AccountReference">("account:contract-owner"),
    sessionReference: brandReference<string, "SessionReference">("session:contract-owner"),
    sessionGeneration: brandReference<string, "SessionGeneration">("1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("1"),
    membershipRevision: brandReference<string, "MembershipRevision">("1"),
  };
}

const query: MarketQuery = { kind: "FinancialQuery", symbol: "KOSPI", purpose: "personal_display", requestRevision: "r0" };

describe.skipIf(!RUN)("KIS index quote — live opt-in contract (real :29443)", () => {
  it("returns a live available KOSPI index level in points", async () => {
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
    // A plausible KOSPI level: the index endpoint answered with a real point value, not a stray field.
    expect(outcome.value.last).toBeGreaterThan(100);
    expect(outcome.value.currency).toBe("pt");
    expect(outcome.licenseScope.audience).toBe("personal");
    expect(Number.isFinite(outcome.value.change)).toBe(true);
  }, 30_000);
});
