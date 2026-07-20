import { describe, expect, it } from "vitest";

import {
  createKisMarketInformation,
  type KisConfig,
  type KisHttp,
  type KisHttpRequest,
} from "../src/modules/financial-information/data/kis-market-information";
import type { MarketQuery } from "../src/modules/financial-information/data/contracts";
import type { ObservationExpiryPolicy } from "../src/modules/financial-information/data/contracts";
import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "../src/shared/contracts/viewer-context";

// Ticket 24 — KIS 모의(:29443) REST 현재가 어댑터. Network-off: a stub KisHttp feeds the
// recorded KIS JSON shape confirmed by the live probe (rt_cd/msg_cd/output), so these tests
// exercise the adapter's real parsing → normalization → InformationOutcome mapping.

const OWNER = brandReference<string, "WorkspaceReference">("workspace:owner");
const NOW = Date.parse("2026-07-20T15:00:00.000Z");

// asOf is taken as receipt time for the (timestamp-less) snapshot; declaredDelay 0 ⇒ realtime.
const POLICY: ObservationExpiryPolicy = { kind: "residual", declaredDelayMs: 0, softResidualMs: 60_000, hardResidualMs: 300_000 };

const CONFIG: KisConfig = {
  base: "https://openapivts.koreainvestment.com:29443",
  appkey: "test-appkey",
  appsecret: "test-appsecret",
  ownerWorkspaceReference: OWNER,
  policy: POLICY,
  licenseValidUntil: "2027-01-01T00:00:00.000Z",
};

function ownerViewer(workspace = OWNER): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-1",
    workspaceReference: workspace,
    accountReference: brandReference<string, "AccountReference">("account:owner"),
    sessionReference: brandReference<string, "SessionReference">("session:owner"),
    sessionGeneration: brandReference<string, "SessionGeneration">("1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("1"),
    membershipRevision: brandReference<string, "MembershipRevision">("1"),
  };
}

function query(symbol: string, purpose: MarketQuery["purpose"] = "personal_display"): MarketQuery {
  return { kind: "FinancialQuery", symbol, purpose, requestRevision: "r0" };
}

// KIS returns every numeric field as a STRING. Values from the live probe (삼성전자 005930).
const TOKEN_JSON = { access_token: "tok-abc", token_type: "Bearer", expires_in: 86_400 };
const QUOTE_JSON = {
  rt_cd: "0",
  msg_cd: "MCA00000",
  msg1: "정상처리 되었습니다.",
  output: { stck_prpr: "244000", prdy_vrss: "-11000", prdy_ctrt: "-4.31", rprs_mrkt_kor_name: "KOSPI" },
};

type Call = { method: string; url: string };

/** A stub transport routing by path; records every call so token-cache/scope tests can assert. */
function stubHttp(overrides: Partial<{ token: unknown; quote: unknown; tokenStatus: number; quoteStatus: number }> = {}): {
  http: KisHttp;
  calls: Call[];
} {
  const calls: Call[] = [];
  const http: KisHttp = async (req: KisHttpRequest) => {
    calls.push({ method: req.method, url: req.url });
    if (req.url.includes("/oauth2/tokenP")) return { status: overrides.tokenStatus ?? 200, json: "token" in overrides ? overrides.token : TOKEN_JSON };
    if (req.url.includes("/quotations/inquire-price")) return { status: overrides.quoteStatus ?? 200, json: "quote" in overrides ? overrides.quote : QUOTE_JSON };
    throw new Error(`unexpected KIS call: ${req.method} ${req.url}`);
  };
  return { http, calls };
}

// sleep never resolves ⇒ withDeadline's timeout branch never fires, so work always wins in the
// normal tests. The deadline test below injects an immediate sleep against a hanging transport.
const clock = { now: () => NOW, sleep: () => new Promise<void>(() => {}) };

describe("KIS market information — happy path (slice 1)", () => {
  it("owner personal_display read returns an available KRW observation from the KIS quote", async () => {
    const { http } = stubHttp();
    const info = createKisMarketInformation({ http, clock, config: CONFIG });

    const outcome = await info.read(query("005930"), ownerViewer()).result;

    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.symbol).toBe("005930");
    expect(outcome.value.last).toBe(244_000);
    expect(outcome.value.currency).toBe("KRW");
    expect(outcome.value.change).toBe(-11_000);
    expect(outcome.value.changePercent).toBe(-4.31);
    expect(outcome.value.priceBasis).toBe("trade");
    expect(outcome.provider).toBe("kis");
    expect(outcome.freshness).toBe("realtime");
    // No-redistribution: KIS personal key carries a personal license, never public.
    expect(outcome.licenseScope.audience).toBe("personal");
    // Provenance present and self-consistent.
    expect(outcome.evidenceReference).toBeTruthy();
    expect(outcome.value.evidenceReference).toBe(outcome.evidenceReference);
  });
});

describe("KIS token cache (slice 2)", () => {
  it("reuses one token across reads within TTL — never re-hits the 1/min tokenP limit", async () => {
    const { http, calls } = stubHttp();
    const info = createKisMarketInformation({ http, clock, config: CONFIG });

    await info.read(query("005930"), ownerViewer()).result;
    await info.read(query("000660"), ownerViewer()).result;

    expect(calls.filter((c) => c.url.includes("/oauth2/tokenP")).length).toBe(1);
    expect(calls.filter((c) => c.url.includes("/inquire-price")).length).toBe(2);
  });

  it("re-issues a token only after it expires", async () => {
    let nowMs = NOW;
    const moving = { now: () => nowMs, sleep: () => new Promise<void>(() => {}) };
    const { http, calls } = stubHttp();
    const info = createKisMarketInformation({ http, clock: moving, config: CONFIG });

    await info.read(query("005930"), ownerViewer()).result;
    nowMs += 86_400_000 + 1; // past expires_in (86400s)
    await info.read(query("005930"), ownerViewer()).result;

    expect(calls.filter((c) => c.url.includes("/oauth2/tokenP")).length).toBe(2);
  });
});

describe("KIS scope guard — no redistribution (slice 3)", () => {
  it("never calls KIS for a guest viewer and returns no value", async () => {
    const { http, calls } = stubHttp();
    const info = createKisMarketInformation({ http, clock, config: CONFIG });

    const outcome = await info.read(query("005930"), { kind: "guest", requestId: "g1" }).result;

    expect(calls.length).toBe(0); // the personal key never touches the wire for a non-owner
    expect(outcome.status).not.toBe("available");
    expect("value" in outcome && (outcome as { value?: unknown }).value).toBeFalsy();
  });

  it("never serves a workspace that is not the single owner", async () => {
    const { http, calls } = stubHttp();
    const info = createKisMarketInformation({ http, clock, config: CONFIG });
    const intruder = ownerViewer(brandReference<string, "WorkspaceReference">("workspace:intruder"));

    const outcome = await info.read(query("005930"), intruder).result;

    expect(calls.length).toBe(0);
    expect(outcome.status).not.toBe("available");
  });

  it("never serves a public_display purpose — a personal key stays personal", async () => {
    const { http, calls } = stubHttp();
    const info = createKisMarketInformation({ http, clock, config: CONFIG });

    const outcome = await info.read(query("005930", "public_display"), ownerViewer()).result;

    expect(calls.length).toBe(0);
    expect(outcome.status).not.toBe("available");
  });
});

describe("KIS error mapping (slice 4)", () => {
  async function readWith(overrides: Parameters<typeof stubHttp>[0]) {
    const { http, calls } = stubHttp(overrides);
    const info = createKisMarketInformation({ http, clock, config: CONFIG });
    const outcome = await info.read(query("005930"), ownerViewer()).result;
    return { outcome, calls };
  }

  it("EGW00201 (초당 거래건수 초과) → failed/quota, retryable with retryAfter", async () => {
    const { outcome } = await readWith({
      quote: { rt_cd: "1", msg_cd: "EGW00201", msg1: "초당 거래건수를 초과하였습니다." },
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("quota");
    expect(outcome.degradation.retryable).toBe(true);
    expect(outcome.degradation.retryAfter).toBeTruthy();
    // SEC-05: only a typed diagnostic handle, never raw provider text.
    expect(outcome.degradation.diagnosticReference.startsWith("diagnostic:")).toBe(true);
  });

  it("quote 5xx → failed/upstream, retryable", async () => {
    const { outcome } = await readWith({ quoteStatus: 500, quote: {} });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("upstream");
    expect(outcome.degradation.retryable).toBe(true);
  });

  it("malformed price (non-numeric) → failed/invalid_response, terminal", async () => {
    const { outcome } = await readWith({
      quote: { rt_cd: "0", msg_cd: "MCA00000", output: { stck_prpr: "N/A", prdy_vrss: "0", prdy_ctrt: "0" } },
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
    expect(outcome.degradation.retryable).toBe(false);
  });

  it("token 401 → failed/reauthentication_required, and the quote is never attempted", async () => {
    const { outcome, calls } = await readWith({ tokenStatus: 401, token: { error_description: "invalid" } });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("reauthentication_required");
    expect(calls.filter((c) => c.url.includes("/inquire-price")).length).toBe(0);
  });

  it("token 403 (KIS 1/min limit) → failed/quota (transient), NOT terminal reauthentication", async () => {
    const { outcome } = await readWith({ tokenStatus: 403, token: { error_description: "1분당 1회" } });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("quota");
    expect(outcome.degradation.retryable).toBe(true);
  });

  it("transport rejection (network/timeout) → failed/timeout, and result never rejects", async () => {
    const http: KisHttp = async () => {
      throw new Error("ETIMEDOUT");
    };
    const info = createKisMarketInformation({ http, clock, config: CONFIG });

    // The contract is that read() always resolves to a typed outcome — never a rejected promise.
    const outcome = await info.read(query("005930"), ownerViewer()).result;

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("timeout");
    expect(outcome.degradation.retryable).toBe(true);
  });

  it("empty / non-JSON quote body → a typed failure, not a crash", async () => {
    const { outcome } = await readWith({ quote: null });
    expect(outcome.status).toBe("failed"); // null body ⇒ rt_cd ≠ "0" path, never a thrown TypeError
  });

  it("blank price string (halted / no-data symbol) → invalid_response, never a fabricated last: 0", async () => {
    const { outcome } = await readWith({
      quote: { rt_cd: "0", msg_cd: "MCA00000", output: { stck_prpr: "", prdy_vrss: "", prdy_ctrt: "" } },
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
    // never surfaces a value, least of all a fabricated 0.
    expect("value" in outcome && (outcome as { value?: unknown }).value).toBeFalsy();
  });
});

describe("KIS deadline & concurrency (slice 6 — codex blockers)", () => {
  it("a hanging transport resolves to a timeout outcome by the data deadline (no infinite spinner)", async () => {
    const http: KisHttp = () => new Promise(() => {}); // never resolves
    const immediateSleep = () => Promise.resolve();
    const info = createKisMarketInformation({ http, clock: { now: () => NOW, sleep: immediateSleep }, config: CONFIG });

    const outcome = await info.read(query("005930"), ownerViewer()).result;

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("timeout");
  });

  it("concurrent reads issue the token only ONCE (single-flight — avoids the 1/min lockout)", async () => {
    let releaseToken: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const calls: Call[] = [];
    const http: KisHttp = async (req) => {
      calls.push({ method: req.method, url: req.url });
      if (req.url.includes("/oauth2/tokenP")) {
        await gate; // both reads must be in-flight on the token before it resolves
        return { status: 200, json: TOKEN_JSON };
      }
      return { status: 200, json: QUOTE_JSON };
    };
    const info = createKisMarketInformation({ http, clock, config: CONFIG });

    const p1 = info.read(query("005930"), ownerViewer()).result;
    const p2 = info.read(query("000660"), ownerViewer()).result;
    releaseToken();
    await Promise.all([p1, p2]);

    expect(calls.filter((c) => c.url.includes("/oauth2/tokenP")).length).toBe(1);
    expect(calls.filter((c) => c.url.includes("/inquire-price")).length).toBe(2);
  });
});
