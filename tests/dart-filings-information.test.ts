import { describe, expect, it } from "vitest";

import {
  createDartFilingsInformation,
  createDisabledFilingsInformation,
  type DartConfig,
  type DartHttp,
} from "../src/modules/financial-information/data/dart-filings-information";

// Ticket 33-a — Open DART 최근 공시 목록 어댑터. Network-off: a stub DartHttp feeds the recorded
// list.json shape (status/message/list[{corp_name, report_nm, rcept_dt, rcept_no}]). The API key
// lives only in config → URL; it must never surface in any outcome.

const CONFIG: DartConfig = {
  base: "https://opendart.fss.or.kr",
  apiKey: "test-dart-key-000",
  licenseValidUntil: "2099-01-01T00:00:00.000Z",
};

const NOW = Date.parse("2026-07-21T05:00:00.000Z");
const clock = { now: () => NOW, sleep: () => new Promise<void>(() => {}) };

const LIST_JSON = {
  status: "000",
  message: "정상",
  list: [
    { corp_name: "삼성전자", report_nm: "주요사항보고서(자기주식취득결정)", rcept_no: "20260721000123", rcept_dt: "20260721", corp_cls: "Y" },
    { corp_name: "SK하이닉스", report_nm: "분기보고서 (2026.06)", rcept_no: "20260720000456", rcept_dt: "20260720", corp_cls: "Y" },
  ],
};

function stubHttp(response: { status?: number; json: unknown }): { http: DartHttp; calls: string[] } {
  const calls: string[] = [];
  const http: DartHttp = async (req) => {
    calls.push(req.url);
    return { status: response.status ?? 200, json: response.json };
  };
  return { http, calls };
}

const guest = { kind: "guest", requestId: "req-guest-1" } as const;

describe("DART filings — happy path", () => {
  it("returns an available filing list with provenance, audience public", async () => {
    const { http, calls } = stubHttp({ json: LIST_JSON });
    const info = createDartFilingsInformation({ http, clock, config: CONFIG });

    const outcome = await info.readRecent(guest);

    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("list.json");
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.kind).toBe("filing");
    if (outcome.value.kind !== "filing") throw new Error("unreachable");
    expect(outcome.value.filings.length).toBe(2);
    const first = outcome.value.filings[0];
    expect(first?.form).toBe("주요사항보고서(자기주식취득결정)");
    expect(first?.source).toBe("삼성전자");
    expect(first?.filedAt).toBe("2026-07-21T00:00:00.000Z");
    expect(first?.accession).toBe("20260721000123");
    expect(first?.link).toContain("20260721000123");
    expect(outcome.provider).toBe("dart");
    expect(outcome.freshness).toBe("realtime");
    expect(outcome.licenseScope.audience).toBe("public");
  });

  it("the API key never surfaces in the outcome", async () => {
    const { http } = stubHttp({ json: LIST_JSON });
    const info = createDartFilingsInformation({ http, clock, config: CONFIG });

    const outcome = await info.readRecent(guest);

    expect(JSON.stringify(outcome)).not.toContain(CONFIG.apiKey);
  });
});

describe("DART filings — error matrix (a failure is never a value)", () => {
  async function outcomeFor(json: unknown, status = 200) {
    const { http } = stubHttp({ status, json });
    return createDartFilingsInformation({ http, clock, config: CONFIG }).readRecent(guest);
  }

  it("status 013 (조회된 데이터 없음) → unavailable/no_data", async () => {
    const outcome = await outcomeFor({ status: "013", message: "조회된 데이터가 없습니다." });
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("no_data");
  });

  it("status 010/011 (키 오류) → failed/reauthentication_required", async () => {
    const outcome = await outcomeFor({ status: "010", message: "등록되지 않은 키입니다." });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("reauthentication_required");
  });

  it("status 020 (요청 제한 초과) → failed/quota (retryable)", async () => {
    const outcome = await outcomeFor({ status: "020", message: "요청 제한을 초과하였습니다." });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("quota");
    expect(outcome.degradation.retryable).toBe(true);
  });

  it("HTTP 500 → failed/upstream; malformed body → invalid_response", async () => {
    const upstream = await outcomeFor({}, 500);
    expect(upstream.status).toBe("failed");
    if (upstream.status !== "failed") throw new Error("unreachable");
    expect(upstream.degradation.code).toBe("upstream");

    const malformed = await outcomeFor({ status: "000", list: "not-a-list" });
    expect(malformed.status).toBe("failed");
    if (malformed.status !== "failed") throw new Error("unreachable");
    expect(malformed.degradation.code).toBe("invalid_response");
  });

  it("a reflected API key anywhere in the body quarantines the whole response", async () => {
    const reflected = {
      status: "000",
      list: [{ corp_name: "X", report_nm: `R-${CONFIG.apiKey}`, rcept_no: "20260721000123", rcept_dt: "20260721" }],
    };
    const outcome = await outcomeFor(reflected);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
    expect(JSON.stringify(outcome)).not.toContain(CONFIG.apiKey);
  });

  it("a non-14-digit rcept_no never becomes an accession/reference", async () => {
    const outcome = await outcomeFor({
      status: "000",
      list: [{ corp_name: "X", report_nm: "R", rcept_no: "javascript:alert(1)", rcept_dt: "20260721" }],
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });

  it("official DART statuses map exhaustively — no blanket retryable upstream", async () => {
    const cases: readonly [string, string, boolean | undefined][] = [
      ["011", "reauthentication_required", false],
      ["901", "reauthentication_required", false], // 사용기한 만료 키
      ["012", "forbidden_upstream", false], // 접근할 수 없는 IP
      ["101", "forbidden_upstream", false], // 부적절한 접근
      ["100", "invalid_response", false], // 필드 부적절 = 우리 요청 결함, 재시도 무의미
      ["021", "quota", true],
      ["800", "upstream", true], // 시스템 점검
    ];
    for (const [code, expected, retryable] of cases) {
      const outcome = await outcomeFor({ status: code, message: "-" });
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") throw new Error("unreachable");
      expect(outcome.degradation.code).toBe(expected);
      if (retryable !== undefined) expect(outcome.degradation.retryable).toBe(retryable);
    }
  });

  it("a filing with a non-date rcept_dt fails closed", async () => {
    const outcome = await outcomeFor({
      status: "000",
      list: [{ corp_name: "X", report_nm: "R", rcept_no: "1", rcept_dt: "언젠가" }],
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });
});

describe("DART filings — gates", () => {
  it("disabled composition (no key / gate off) → api_required with zero network", async () => {
    const info = createDisabledFilingsInformation();
    const outcome = await info.readRecent(guest);
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("api_required");
  });
});
