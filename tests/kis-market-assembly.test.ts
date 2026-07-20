import { describe, expect, it } from "vitest";

import { assembleMarketInformation } from "../src/composition/market-assembly";
import type { KisHttp, KisConfig } from "../src/modules/financial-information/data/kis-market-information";
import type { MarketQuery, ObservationExpiryPolicy } from "../src/modules/financial-information/data/contracts";
import { loadSyntheticMarketCatalog } from "../src/modules/financial-information/data/scripted-market-information";
import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "../src/shared/contracts/viewer-context";

// 26-a: the composition assembly picks the KIS adapter when enabled, else the scripted fallback.
const OWNER = brandReference<string, "WorkspaceReference">("workspace:owner");
const NOW = Date.parse("2026-07-21T01:00:00.000Z"); // Tue 10:00 KST (in session)
const POLICY: ObservationExpiryPolicy = { kind: "residual", declaredDelayMs: 60_000, softResidualMs: 900_000, hardResidualMs: 3 * 24 * 3_600_000 };
const clock = { now: () => NOW, sleep: () => new Promise<void>(() => {}) };

const KIS_CONFIG: KisConfig = {
  base: "https://openapivts.koreainvestment.com:29443",
  appkey: "k",
  appsecret: "s",
  ownerWorkspaceReference: OWNER,
  policy: POLICY,
  licenseValidUntil: "2099-01-01T00:00:00.000Z",
};
const QUOTE_JSON = { rt_cd: "0", msg_cd: "MCA00000", output: { stck_prpr: "244000", prdy_vrss: "-11000", prdy_ctrt: "-4.31" } };

function ownerViewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "r",
    workspaceReference: OWNER,
    accountReference: brandReference<string, "AccountReference">("account:owner"),
    sessionReference: brandReference<string, "SessionReference">("session:owner"),
    sessionGeneration: brandReference<string, "SessionGeneration">("1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("1"),
    membershipRevision: brandReference<string, "MembershipRevision">("1"),
  };
}
const query = (symbol: string): MarketQuery => ({ kind: "FinancialQuery", symbol, purpose: "personal_display", requestRevision: "r0" });

describe("market assembly (26-a)", () => {
  it("backend=kis wires the KIS adapter (hits the injected transport, returns live KRW)", async () => {
    const calls: string[] = [];
    const http: KisHttp = async (req) => {
      calls.push(req.url);
      if (req.url.includes("/oauth2/tokenP")) return { status: 200, json: { access_token: "t", expires_in: 86_400 } };
      return { status: 200, json: QUOTE_JSON };
    };
    const { provider, backend } = assembleMarketInformation("kis", { clock, kis: { http, config: KIS_CONFIG } });

    const outcome = await provider.read(query("005930"), ownerViewer()).result;

    expect(backend).toBe("kis");
    expect(calls.some((u) => u.includes("/inquire-price"))).toBe(true);
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.currency).toBe("KRW");
  });

  it("backend=scripted wires the synthetic fallback (no network, serves the synthetic catalog)", async () => {
    const catalog = loadSyntheticMarketCatalog();
    const sample = catalog.cases[0]!.symbol;
    const { provider, backend } = assembleMarketInformation("scripted", { clock });

    const outcome = await provider.read(query(sample), ownerViewer()).result;

    expect(backend).toBe("scripted");
    // synthetic provider produces a typed outcome for its own catalog symbol with no transport at all.
    expect(outcome.policyVersion).toBeTruthy();
  });
});
