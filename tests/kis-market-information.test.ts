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
const NOW = Date.parse("2026-07-21T01:00:00.000Z"); // Tue 10:00 KST — inside the KRX session (live/trade)

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

  // ticket 34, 실 서버 실측: 유량 초과는 HTTP 200이 아니라 **500 + rt_cd=1/EGW00201**로 온다.
  // 상태코드만 보고 분류하면 quota 특례가 죽고 upstream으로 오분류된다.
  it("EGW00201 as HTTP 500 (real KIS shape) → still failed/quota, not upstream", async () => {
    const { outcome } = await readWith({
      quoteStatus: 500,
      quote: { rt_cd: "1", msg_cd: "EGW00201", msg1: "초당 거래건수를 초과하였습니다." },
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("quota");
    expect(outcome.degradation.retryAfter).toBeTruthy();
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

describe("KIS session freshness (ticket 25 — codex HIGH 2)", () => {
  // Generous residual policy so off-session prev-close surfaces as STALE (not dropped), letting us
  // assert priceBasis/freshness deterministically.
  const SESSION_POLICY: ObservationExpiryPolicy = {
    kind: "residual",
    declaredDelayMs: 60_000,
    softResidualMs: 15 * 60_000,
    hardResidualMs: 7 * 24 * 3_600_000,
  };

  async function readAt(iso: string) {
    const { http } = stubHttp();
    const info = createKisMarketInformation({
      http,
      clock: { now: () => Date.parse(iso), sleep: () => new Promise<void>(() => {}) },
      config: { ...CONFIG, policy: SESSION_POLICY },
    });
    return info.read(query("005930"), ownerViewer()).result;
  }

  it("in-session (Tue 10:00 KST) → realtime / trade", async () => {
    const outcome = await readAt("2026-07-21T01:00:00Z");
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.freshness).toBe("realtime");
    expect(outcome.value.priceBasis).toBe("trade");
  });

  it("after close (Tue 17:00 KST) → eod, and NOT realtime (prev close is not a live trade)", async () => {
    const outcome = await readAt("2026-07-21T08:00:00Z");
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.priceBasis).toBe("eod");
    expect(outcome.freshness).not.toBe("realtime");
    expect(outcome.value.last).toBe(244_000); // value still surfaced, just honestly aged
  });

  it("weekend (Sat 12:00 KST) → eod, not realtime", async () => {
    const outcome = await readAt("2026-07-25T03:00:00Z");
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.priceBasis).toBe("eod");
    expect(outcome.freshness).not.toBe("realtime");
  });

  it("session boundaries are half-open [09:00, 15:30): open tick is trade, close tick is eod", async () => {
    const open = await readAt("2026-07-21T00:00:00Z"); // exactly 09:00 KST
    const close = await readAt("2026-07-21T06:30:00Z"); // exactly 15:30 KST
    if (open.status !== "available" || close.status !== "available") throw new Error("unreachable");
    expect(open.value.priceBasis).toBe("trade");
    expect(close.value.priceBasis).toBe("eod");
  });

  it("before the open (Tue 08:00 KST) → eod (previous weekday close, not today)", async () => {
    const outcome = await readAt("2026-07-20T23:00:00Z"); // Tue 08:00 KST
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.priceBasis).toBe("eod");
    expect(outcome.freshness).not.toBe("realtime");
  });
});

describe("KIS holiday freshness (ticket 29 — 평일 휴장일 실시간 위조 봉쇄)", () => {
  // Generous residual so a prev close many days back still surfaces (stale) for a deterministic assert.
  const SESSION_POLICY: ObservationExpiryPolicy = {
    kind: "residual",
    declaredDelayMs: 60_000,
    softResidualMs: 15 * 60_000,
    hardResidualMs: 30 * 24 * 3_600_000,
  };
  async function readAt(iso: string) {
    const { http } = stubHttp();
    const info = createKisMarketInformation({
      http,
      clock: { now: () => Date.parse(iso), sleep: () => new Promise<void>(() => {}) },
      config: { ...CONFIG, policy: SESSION_POLICY },
    });
    return info.read(query("005930"), ownerViewer()).result;
  }

  // Each is a WEEKDAY at 10:00 KST (inside 09:00–15:30) that faked `trade` before the fix.
  it.each([
    ["신정", "2026-01-01T01:00:00Z"],
    ["설날", "2026-02-17T01:00:00Z"],
    ["삼일절 대체(3/1 일)", "2026-03-02T01:00:00Z"],
    ["지방선거", "2026-06-03T01:00:00Z"],
    ["연말 폐장", "2026-12-31T01:00:00Z"],
  ])("weekday holiday %s at 10:00 KST → eod, never a fabricated realtime trade", async (_name, iso) => {
    const outcome = await readAt(iso);
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.priceBasis).toBe("eod");
    expect(outcome.freshness).not.toBe("realtime");
  });

  it("9/28(월)은 거래일 — 추석 연휴 9/26이 토요일이라 대체 없음 → trade", async () => {
    const outcome = await readAt("2026-09-28T01:00:00Z"); // Mon 10:00 KST
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.priceBasis).toBe("trade");
  });

  it("step-back가 설날 블록+주말을 건너뜀: 2/19 08:00 KST 개장전 → 직전 마감은 2/13(금)", async () => {
    const outcome = await readAt("2026-02-18T23:00:00Z"); // 2026-02-19 08:00 KST, before open
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.priceBasis).toBe("eod");
    expect(outcome.asOf.startsWith("2026-02-13")).toBe(true);
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

// ticket 37, 실 서버 실측: 없는 종목(ZZZZ)에도 KIS는 rt_cd=0 + 가격 "0"을 준다. 엄격 십진 파서는
// "0"을 정상 숫자로 받으므로 그대로 두면 **없는 종목에 0원짜리 시세가 생긴다** — 이 프로젝트가
// 절대 하지 않기로 한 것(값을 모르면 만들지 않는다). 검색이 임의 심볼을 열면서 도달 가능해졌다.
describe("KIS zero-priced quote (37)", () => {
  const zeroQuote = { rt_cd: "0", msg_cd: "MCA00000", output: { stck_prpr: "0", prdy_vrss: "0", prdy_ctrt: "0" } };

  it("a zero stock price is not a 0원 value → unavailable/no_data", async () => {
    const http: KisHttp = async (req) => {
      if (req.url.includes("/oauth2/tokenP")) return { status: 200, json: { access_token: "t", expires_in: 3600 } };
      return { status: 200, json: zeroQuote };
    };
    const info = createKisMarketInformation({ http, clock, config: CONFIG });
    const outcome = await info.read(query("ZZZZ"), ownerViewer()).result;
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("no_data");
  });

  it("keeps a malformed(빈 문자열) response distinct from an honest zero", async () => {
    const http: KisHttp = async (req) => {
      if (req.url.includes("/oauth2/tokenP")) return { status: 200, json: { access_token: "t", expires_in: 3600 } };
      return { status: 200, json: { rt_cd: "0", msg_cd: "MCA00000", output: { stck_prpr: "", prdy_vrss: "", prdy_ctrt: "" } } };
    };
    const info = createKisMarketInformation({ http, clock, config: CONFIG });
    const outcome = await info.read(query("ZZZZ"), ownerViewer()).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });

  it("a real price is untouched by the zero gate", async () => {
    const http: KisHttp = async (req) => {
      if (req.url.includes("/oauth2/tokenP")) return { status: 200, json: { access_token: "t", expires_in: 3600 } };
      return { status: 200, json: { rt_cd: "0", msg_cd: "MCA00000", output: { stck_prpr: "259000", prdy_vrss: "15000", prdy_ctrt: "6.15" } } };
    };
    const info = createKisMarketInformation({ http, clock, config: CONFIG });
    const outcome = await info.read(query("005930"), ownerViewer()).result;
    expect(outcome.status).toBe("available");
  });
});
