import { describe, expect, it } from "vitest";

import {
  createKisMarketInformation,
  type KisConfig,
  type KisHttp,
  type KisHttpRequest,
} from "../src/modules/financial-information/data/kis-market-information";
import type { MarketQuery, ObservationExpiryPolicy } from "../src/modules/financial-information/data/contracts";
import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "../src/shared/contracts/viewer-context";

// Ticket 31-a — KIS 국내업종 현재지수 (inquire-index-price, TR FHPUP02100000, 시장분류 U).
// Index symbols ride the same MarketInformation port and the same personal-scope guard: the
// owner-only / no-redistribution fence must hold for indices exactly as it does for stocks.

const OWNER = brandReference<string, "WorkspaceReference">("workspace:owner");
const NOW = Date.parse("2026-07-21T01:00:00.000Z"); // Tue 10:00 KST — inside the KRX session

const POLICY: ObservationExpiryPolicy = { kind: "residual", declaredDelayMs: 0, softResidualMs: 60_000, hardResidualMs: 300_000 };

const CONFIG: KisConfig = {
  base: "https://openapivts.koreainvestment.com:29443",
  appkey: "test-appkey",
  appsecret: "test-appsecret",
  ownerWorkspaceReference: OWNER,
  policy: POLICY,
  licenseValidUntil: "2027-01-01T00:00:00.000Z",
};

function ownerViewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-1",
    workspaceReference: OWNER,
    accountReference: brandReference<string, "AccountReference">("account:owner"),
    sessionReference: brandReference<string, "SessionReference">("session:owner"),
    sessionGeneration: brandReference<string, "SessionGeneration">("1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("1"),
    membershipRevision: brandReference<string, "MembershipRevision">("1"),
  };
}

function query(symbol: string): MarketQuery {
  return { kind: "FinancialQuery", symbol, purpose: "personal_display", requestRevision: "r0" };
}

const TOKEN_JSON = { access_token: "tok-abc", token_type: "Bearer", expires_in: 86_400 };
// KIS index output shape (업종지수 필드는 bstp_nmix_* 프리픽스, 문자열 숫자).
const INDEX_JSON = {
  rt_cd: "0",
  msg_cd: "MCA00000",
  output: { bstp_nmix_prpr: "6750.12", bstp_nmix_prdy_vrss: "35.20", bstp_nmix_prdy_ctrt: "0.52" },
};

type Call = { url: string; headers: Readonly<Record<string, string>> };

function stubHttp(): { http: KisHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: KisHttp = async (req: KisHttpRequest) => {
    calls.push({ url: req.url, headers: req.headers });
    if (req.url.includes("/oauth2/tokenP")) return { status: 200, json: TOKEN_JSON };
    if (req.url.includes("/quotations/inquire-index-price")) return { status: 200, json: INDEX_JSON };
    throw new Error(`unexpected KIS call: ${req.url}`);
  };
  return { http, calls };
}

const clock = { now: () => NOW, sleep: () => new Promise<void>(() => {}) };

describe("KIS index quotes (ticket 31)", () => {
  it("owner KOSPI read returns an available point observation from the index endpoint", async () => {
    const { http, calls } = stubHttp();
    const info = createKisMarketInformation({ http, clock, config: CONFIG });

    const outcome = await info.read(query("KOSPI"), ownerViewer()).result;

    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.symbol).toBe("KOSPI");
    expect(outcome.value.last).toBe(6750.12);
    expect(outcome.value.currency).toBe("pt");
    expect(outcome.value.change).toBe(35.2);
    expect(outcome.value.changePercent).toBe(0.52);
    expect(outcome.value.priceBasis).toBe("trade");
    expect(outcome.freshness).toBe("realtime");
    expect(outcome.licenseScope.audience).toBe("personal");

    const indexCall = calls.find((c) => c.url.includes("inquire-index-price"));
    expect(indexCall).toBeDefined();
    expect(indexCall?.url).toContain("fid_cond_mrkt_div_code=U");
    expect(indexCall?.url).toContain("fid_input_iscd=0001");
    expect(indexCall?.headers.tr_id).toBe("FHPUP02100000");
  });

  it("KOSDAQ maps to its own index code", async () => {
    const { http, calls } = stubHttp();
    const info = createKisMarketInformation({ http, clock, config: CONFIG });

    const outcome = await info.read(query("KOSDAQ"), ownerViewer()).result;

    expect(outcome.status).toBe("available");
    expect(calls.find((c) => c.url.includes("inquire-index-price"))?.url).toContain("fid_input_iscd=1001");
  });

  it("guest viewers get api_required with ZERO network — the personal fence covers indices", async () => {
    const { http, calls } = stubHttp();
    const info = createKisMarketInformation({ http, clock, config: CONFIG });

    const outcome = await info.read(query("KOSPI"), { kind: "guest", requestId: "g1" }).result;

    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("api_required");
    expect(calls.length).toBe(0);
  });

  it("a blank index price is never a 0-point value → invalid_response", async () => {
    const blank = { rt_cd: "0", msg_cd: "MCA00000", output: { bstp_nmix_prpr: "", bstp_nmix_prdy_vrss: "", bstp_nmix_prdy_ctrt: "" } };
    const http: KisHttp = async (req) => {
      if (req.url.includes("/oauth2/tokenP")) return { status: 200, json: TOKEN_JSON };
      return { status: 200, json: blank };
    };
    const info = createKisMarketInformation({ http, clock, config: CONFIG });

    const outcome = await info.read(query("KOSPI"), ownerViewer()).result;

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });

  it("stock symbols keep routing to the stock endpoint (regression)", async () => {
    const stockJson = {
      rt_cd: "0",
      msg_cd: "MCA00000",
      output: { stck_prpr: "244000", prdy_vrss: "-11000", prdy_ctrt: "-4.31" },
    };
    const calls: string[] = [];
    const http: KisHttp = async (req) => {
      calls.push(req.url);
      if (req.url.includes("/oauth2/tokenP")) return { status: 200, json: TOKEN_JSON };
      if (req.url.includes("/quotations/inquire-price")) return { status: 200, json: stockJson };
      throw new Error(`unexpected KIS call: ${req.url}`);
    };
    const info = createKisMarketInformation({ http, clock, config: CONFIG });

    const outcome = await info.read(query("005930"), ownerViewer()).result;

    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.last).toBe(244_000);
    expect(outcome.value.currency).toBe("KRW");
    expect(calls.some((url) => url.includes("inquire-index-price"))).toBe(false);
  });
});
