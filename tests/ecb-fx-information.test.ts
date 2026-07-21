import { describe, expect, it } from "vitest";

import {
  createEcbFxInformation,
  ECB_FX_SYMBOLS,
  type EcbConfig,
  type EcbHttp,
} from "../src/modules/financial-information/data/ecb-fx-information";
import type { MarketQuery } from "../src/modules/financial-information/data/contracts";

// Ticket 32-a — ECB 일별 기준환율 교차(USD/KRW) 어댑터. Network-off: a stub EcbHttp feeds the
// recorded SDMX csvdata shape from the live probe (KEY,...,TIME_PERIOD(6),OBS_VALUE(7), one row
// per currency·date). USD/KRW is DERIVED (KRW.EUR ÷ USD.EUR) and must say so: priceBasis
// "indicative", cross only on dates where BOTH series published (no half-cross fabrication).

const HEADER =
  "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF," +
  "OBS_PRE_BREAK,OBS_COM,TIME_FORMAT,BREAKS,COLLECTION,COMPILING_ORG,DISS_ORG,DOM_SER_IDS,PUBL_ECB," +
  "PUBL_MU,PUBL_PUBLIC,UNIT_INDEX_BASE,COMPILATION,COVERAGE,DECIMALS,NAT_TITLE,SOURCE_AGENCY," +
  "SOURCE_PUB,TITLE,TITLE_COMPL,UNIT,UNIT_MULT";

function row(currency: "USD" | "KRW", date: string, value: string): string {
  return (
    `EXR.D.${currency}.EUR.SP00.A,D,${currency},EUR,SP00,A,${date},${value},A,F,,,P1D,,A,,,,,,,` +
    `99Q1=100,,,2,,4F0,,${currency}/Euro rate,"ECB reference exchange rate, ${currency}/Euro, 2.15 pm (C.E.T.)",${currency},0`
  );
}

function csv(rows: readonly string[]): string {
  return [HEADER, ...rows].join("\n");
}

// Live-probe values: Fri 7/17 → 1698.46/1.1435 ≈ 1485.32, Mon 7/20 → 1692.4/1.1426 ≈ 1481.18.
const FIXTURE = csv([
  row("KRW", "2026-07-17", "1698.46"),
  row("KRW", "2026-07-20", "1692.4"),
  row("USD", "2026-07-17", "1.1435"),
  row("USD", "2026-07-20", "1.1426"),
]);

const CONFIG: EcbConfig = {
  base: "https://data-api.ecb.europa.eu",
  licenseValidUntil: "2099-01-01T00:00:00.000Z",
};

// Mon 2026-07-20 14:00Z — before the ~15:30Z expected publication ⇒ zero missed ⇒ realtime.
const NOW = Date.parse("2026-07-20T14:00:00.000Z");
const clock = { now: () => NOW, sleep: () => new Promise<void>(() => {}) };

function stubHttp(response: { status?: number; body: string }): { http: EcbHttp; calls: string[] } {
  const calls: string[] = [];
  const http: EcbHttp = async (req) => {
    calls.push(req.url);
    return { status: response.status ?? 200, body: response.body };
  };
  return { http, calls };
}

function query(symbol: string, purpose: MarketQuery["purpose"] = "public_display"): MarketQuery {
  return { kind: "FinancialQuery", symbol, purpose, requestRevision: "r0" };
}

const guest = { kind: "guest", requestId: "req-guest-1" } as const;

describe("ECB FX cross — happy path", () => {
  it("derives USD/KRW from the latest common publication date, marked indicative", async () => {
    const { http, calls } = stubHttp({ body: FIXTURE });
    const info = createEcbFxInformation({ http, clock, config: CONFIG });

    const outcome = await info.read(query("USDKRW"), guest).result;

    expect(calls.length).toBe(1);
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.symbol).toBe("USDKRW");
    expect(outcome.value.last).toBeCloseTo(1692.4 / 1.1426, 8);
    expect(outcome.value.currency).toBe("KRW");
    expect(outcome.value.change).toBeCloseTo(1692.4 / 1.1426 - 1698.46 / 1.1435, 8);
    expect(outcome.value.priceBasis).toBe("indicative"); // derived cross, not a traded price
    expect(outcome.provider).toBe("ecb");
    expect(outcome.feed).toContain("cross");
    expect(outcome.freshness).toBe("realtime");
    expect(outcome.asOf).toBe("2026-07-20T00:00:00.000Z");
    expect(outcome.licenseScope.audience).toBe("public");
  });

  it("ECB_FX_SYMBOLS advertises exactly the servable pairs", () => {
    expect([...ECB_FX_SYMBOLS]).toEqual(["USDKRW"]);
  });
});

describe("ECB FX cross — honesty gates", () => {
  it("uses the latest COMMON date when one series lags (no half-cross)", async () => {
    const lagging = csv([
      row("KRW", "2026-07-16", "1690.00"),
      row("KRW", "2026-07-17", "1698.46"),
      row("USD", "2026-07-16", "1.1450"),
      row("USD", "2026-07-17", "1.1435"),
      row("USD", "2026-07-20", "1.1426"), // KRW 7/20 missing → 7/20 cross must not exist
    ]);
    const { http } = stubHttp({ body: lagging });
    const info = createEcbFxInformation({ http, clock, config: CONFIG });

    const outcome = await info.read(query("USDKRW"), guest).result;

    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.asOf).toBe("2026-07-17T00:00:00.000Z");
    expect(outcome.value.last).toBeCloseTo(1698.46 / 1.1435, 8);
  });

  it("fewer than 2 common dates → invalid_response (change would be fabricated)", async () => {
    const single = csv([row("KRW", "2026-07-20", "1692.4"), row("USD", "2026-07-20", "1.1426")]);
    const { http } = stubHttp({ body: single });
    const info = createEcbFxInformation({ http, clock, config: CONFIG });
    const outcome = await info.read(query("USDKRW"), guest).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });

  it("a zero denominator rate is never a value → invalid_response", async () => {
    const zero = csv([
      row("KRW", "2026-07-17", "1698.46"),
      row("KRW", "2026-07-20", "1692.4"),
      row("USD", "2026-07-17", "1.1435"),
      row("USD", "2026-07-20", "0"),
    ]);
    const { http } = stubHttp({ body: zero });
    const info = createEcbFxInformation({ http, clock, config: CONFIG });
    const outcome = await info.read(query("USDKRW"), guest).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });

  it("non-decimal observation values fail closed", async () => {
    const garbled = csv([
      row("KRW", "2026-07-17", "1698.46"),
      row("KRW", "2026-07-20", "0x10"),
      row("USD", "2026-07-17", "1.1435"),
      row("USD", "2026-07-20", "1.1426"),
    ]);
    const { http } = stubHttp({ body: garbled });
    const info = createEcbFxInformation({ http, clock, config: CONFIG });
    const outcome = await info.read(query("USDKRW"), guest).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });

  it("HTTP 500 → failed/upstream; garbage body → invalid_response", async () => {
    const { http } = stubHttp({ status: 500, body: "" });
    const info = createEcbFxInformation({ http, clock, config: CONFIG });
    const upstream = await info.read(query("USDKRW"), guest).result;
    expect(upstream.status).toBe("failed");
    if (upstream.status !== "failed") throw new Error("unreachable");
    expect(upstream.degradation.code).toBe("upstream");

    const { http: badBody } = stubHttp({ body: "<html>oops</html>" });
    const info2 = createEcbFxInformation({ http: badBody, clock, config: CONFIG });
    const invalid = await info2.read(query("USDKRW"), guest).result;
    expect(invalid.status).toBe("failed");
    if (invalid.status !== "failed") throw new Error("unreachable");
    expect(invalid.degradation.code).toBe("invalid_response");
  });
});

describe("ECB FX cross — scope gates and freshness", () => {
  it("unknown symbol → no_data, zero network; non-public purpose → api_required, zero network", async () => {
    const { http, calls } = stubHttp({ body: FIXTURE });
    const info = createEcbFxInformation({ http, clock, config: CONFIG });

    const unknown = await info.read(query("EURJPY"), guest).result;
    expect(unknown.status).toBe("unavailable");
    if (unknown.status !== "unavailable") throw new Error("unreachable");
    expect(unknown.reason).toBe("no_data");

    const personal = await info.read(query("USDKRW", "personal_display"), guest).result;
    expect(personal.status).toBe("unavailable");
    if (personal.status !== "unavailable") throw new Error("unreachable");
    expect(personal.reason).toBe("api_required");

    expect(calls.length).toBe(0);
  });

  it("ages by expected business-day publications (~15:30Z): grace, stale, then no value", async () => {
    async function at(nowIso: string) {
      const { http } = stubHttp({ body: FIXTURE });
      const aged = { now: () => Date.parse(nowIso), sleep: () => new Promise<void>(() => {}) };
      return createEcbFxInformation({ http, clock: aged, config: CONFIG }).read(query("USDKRW"), guest).result;
    }
    // Value asOf Mon 7/20. Tue 16:00Z: Tue publication (15:30) missed but within +2h grace.
    const grace = await at("2026-07-21T16:00:00.000Z");
    expect(grace.status).toBe("available");
    if (grace.status !== "available") throw new Error("unreachable");
    expect(grace.freshness).toBe("realtime");
    // Wed 10:00Z: one missed past grace → stale.
    const stale = await at("2026-07-22T10:00:00.000Z");
    expect(stale.status).toBe("available");
    if (stale.status !== "available") throw new Error("unreachable");
    expect(stale.freshness).toBe("stale");
    // Wed 16:00Z: Tue + Wed missed → hard, no value.
    const hard = await at("2026-07-22T16:00:00.000Z");
    expect(hard.status).toBe("unavailable");
    if (hard.status !== "unavailable") throw new Error("unreachable");
    expect(hard.reason).toBe("no_data");
  });
});
