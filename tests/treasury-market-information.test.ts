import { describe, expect, it } from "vitest";

import {
  createDisabledPublicMarketInformation,
  createPublicMarketInformation,
  withTreasuryCache,
  type TreasuryConfig,
  type TreasuryHttp,
} from "../src/modules/financial-information/data/treasury-market-information";
import type { MarketQuery } from "../src/modules/financial-information/data/contracts";

// Ticket 28-a — 미 재무부 Daily Par Yield Curve 어댑터. Network-off: a stub TreasuryHttp feeds the
// recorded Atom/OData XML shape confirmed by the ticket-27 live probe (entry → m:properties →
// d:NEW_DATE + d:BC_*), so these tests exercise real parsing → normalization → InformationOutcome.
// Freshness follows spec §5.1 "Treasury·ECB daily": soft = next expected publication + 2h,
// hard = two missed expected business-day publications.

// Tue 2026-07-14 20:00Z — before that day's expected ~20:30Z publication ⇒ zero missed ⇒ realtime.
const NOW = Date.parse("2026-07-14T20:00:00.000Z");

const CONFIG: TreasuryConfig = {
  base: "https://home.treasury.gov",
  licenseValidUntil: "2099-01-01T00:00:00.000Z",
};

function entry(date: string, fields: Readonly<Record<string, string>>, attrs = ""): string {
  const props = Object.entries(fields)
    .map(([name, value]) => `<d:${name} m:type="Edm.Double">${value}</d:${name}>`)
    .join("");
  return (
    `<entry${attrs}><id>id-${date}</id><content type="application/xml"><m:properties>` +
    `<d:NEW_DATE m:type="Edm.DateTime">${date}T00:00:00</d:NEW_DATE>${props}` +
    `</m:properties></content></entry>`
  );
}

function feed(entries: readonly string[]): string {
  return (
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?>` +
    `<feed xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" ` +
    `xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" ` +
    `xmlns="http://www.w3.org/2005/Atom"><updated>2026-07-14T15:46:44Z</updated>` +
    entries.join("") +
    `</feed>`
  );
}

// Two consecutive publications: change/changePercent derive from the prior entry, never fabricated.
const FIXTURE_2026 = feed([
  entry("2026-07-13", { BC_2YEAR: "4.70", BC_10YEAR: "4.30" }),
  entry("2026-07-14", { BC_2YEAR: "4.75", BC_10YEAR: "4.33" }),
]);

// Thu 7/16 + Fri 7/17 — drives the weekend/business-day freshness suite.
const FIXTURE_WEEK_END = feed([
  entry("2026-07-16", { BC_10YEAR: "4.30" }),
  entry("2026-07-17", { BC_10YEAR: "4.33" }),
]);

/** Stub transport routing by requested year; records calls so zero-network tests can assert. */
function stubHttp(byYear: Readonly<Record<string, { status?: number; body: string }>>): {
  http: TreasuryHttp;
  calls: string[];
} {
  const calls: string[] = [];
  const http: TreasuryHttp = async (req) => {
    calls.push(req.url);
    const year = /field_tdr_date_value=(\d{4})/.exec(req.url)?.[1] ?? "";
    const res = byYear[year];
    if (!res) throw new Error(`unexpected treasury call: ${req.url}`);
    return { status: res.status ?? 200, body: res.body };
  };
  return { http, calls };
}

const clock = { now: () => NOW, sleep: () => new Promise<void>(() => {}) };

function query(symbol: string, purpose: MarketQuery["purpose"] = "public_display"): MarketQuery {
  return { kind: "FinancialQuery", symbol, purpose, requestRevision: "r0" };
}

const guest = { kind: "guest", requestId: "req-guest-1" } as const;

function adapter(byYear: Readonly<Record<string, { status?: number; body: string }>>) {
  const { http, calls } = stubHttp(byYear);
  return { info: createPublicMarketInformation({ http, clock, config: CONFIG }), calls };
}

describe("Treasury yield curve — happy path", () => {
  it("guest public_display read returns an available % observation from the latest entry", async () => {
    const { info } = adapter({ "2026": { body: FIXTURE_2026 } });

    const outcome = await info.read(query("UST10Y"), guest).result;

    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.symbol).toBe("UST10Y");
    expect(outcome.value.last).toBe(4.33);
    expect(outcome.value.currency).toBe("%");
    expect(outcome.value.change).toBeCloseTo(0.03, 10);
    expect(outcome.value.changePercent).toBeCloseTo((0.03 / 4.3) * 100, 6);
    expect(outcome.value.priceBasis).toBe("eod");
    expect(outcome.provider).toBe("treasury");
    expect(outcome.freshness).toBe("realtime");
    expect(outcome.asOf).toBe("2026-07-14T00:00:00.000Z");
    // Redistribution boundary: this feed is public-domain — the outcome says so explicitly.
    expect(outcome.licenseScope.audience).toBe("public");
    expect(outcome.licenseScope.purposes).toContain("public_display");
    expect(outcome.evidenceReference).toBeTruthy();
    expect(outcome.value.evidenceReference).toBe(outcome.evidenceReference);
  });

  it("serves the 2Y tenor as its own symbol", async () => {
    const { info } = adapter({ "2026": { body: FIXTURE_2026 } });
    const outcome = await info.read(query("UST2Y"), guest).result;
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.last).toBe(4.75);
  });
});

describe("Treasury freshness — spec §5.1 expected business-day publications", () => {
  async function outcomeAt(nowIso: string) {
    const { http } = stubHttp({ "2026": { body: FIXTURE_WEEK_END } });
    const at = { now: () => Date.parse(nowIso), sleep: () => new Promise<void>(() => {}) };
    const info = createPublicMarketInformation({ http, clock: at, config: CONFIG });
    return info.read(query("UST10Y"), guest).result;
  }

  it("Friday's curve stays realtime across the weekend (no expected publication missed)", async () => {
    const outcome = await outcomeAt("2026-07-19T12:00:00.000Z"); // Sunday
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.freshness).toBe("realtime");
  });

  it("Monday's publication missed but within the +2h grace → still realtime", async () => {
    const outcome = await outcomeAt("2026-07-20T21:30:00.000Z"); // Mon, expected ~20:30Z
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.freshness).toBe("realtime");
  });

  it("one missed publication past grace → stale, value retained", async () => {
    const outcome = await outcomeAt("2026-07-21T10:00:00.000Z"); // Tue morning
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.freshness).toBe("stale");
  });

  it("two missed expected business-day publications → hard-expired, no value", async () => {
    const outcome = await outcomeAt("2026-07-21T23:00:00.000Z"); // Tue night: Mon + Tue missed
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("no_data");
  });

  it("a future-dated entry is never a value → invalid_response", async () => {
    const future = feed([
      entry("2026-07-16", { BC_10YEAR: "4.30" }),
      entry("2026-07-24", { BC_10YEAR: "4.33" }),
    ]);
    const { http } = stubHttp({ "2026": { body: future } });
    const at = { now: () => Date.parse("2026-07-21T10:00:00.000Z"), sleep: () => new Promise<void>(() => {}) };
    const info = createPublicMarketInformation({ http, clock: at, config: CONFIG });
    const outcome = await info.read(query("UST10Y"), guest).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });
});

describe("Treasury parser honesty — no misparse becomes a value", () => {
  it("a prefix-colliding field (BC_10YEAR_EXTRA) never shadows the real tenor", async () => {
    const colliding = feed([
      entry("2026-07-13", { BC_10YEAR_EXTRA: "9.90", BC_10YEAR: "4.30" }),
      entry("2026-07-14", { BC_10YEAR_EXTRA: "9.99", BC_10YEAR: "4.33" }),
    ]);
    const { info } = adapter({ "2026": { body: colliding } });
    const outcome = await info.read(query("UST10Y"), guest).result;
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.last).toBe(4.33);
  });

  it("non-decimal lexical value (hex '0x10') → invalid_response, never 16", async () => {
    const hex = feed([
      entry("2026-07-13", { BC_10YEAR: "4.30" }),
      entry("2026-07-14", { BC_10YEAR: "0x10" }),
    ]);
    const { info } = adapter({ "2026": { body: hex } });
    const outcome = await info.read(query("UST10Y"), guest).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });

  it("an impossible calendar date (2026-02-30) fails closed instead of drifting to March", async () => {
    const impossible = feed([
      entry("2026-02-27", { BC_10YEAR: "4.30" }),
      entry("2026-02-30", { BC_10YEAR: "4.33" }),
    ]);
    const { http } = stubHttp({ "2026": { body: impossible } });
    const at = { now: () => Date.parse("2026-03-02T12:00:00.000Z"), sleep: () => new Promise<void>(() => {}) };
    const info = createPublicMarketInformation({ http, clock: at, config: CONFIG });
    const outcome = await info.read(query("UST10Y"), guest).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });

  it("duplicate-date entries are one revision: the later document entry wins, change uses the prior date", async () => {
    const revised = feed([
      entry("2026-07-13", { BC_10YEAR: "4.30" }),
      entry("2026-07-14", { BC_10YEAR: "9.99" }),
      entry("2026-07-14", { BC_10YEAR: "4.33" }), // correction supersedes the same-date entry above
    ]);
    const { info } = adapter({ "2026": { body: revised } });
    const outcome = await info.read(query("UST10Y"), guest).result;
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.last).toBe(4.33);
    expect(outcome.value.change).toBeCloseTo(0.03, 10); // vs 7/13, never vs the superseded revision
  });

  it("entry tags carrying attributes (m:etag) still parse", async () => {
    const withAttrs = feed([
      entry("2026-07-13", { BC_10YEAR: "4.30" }, ' m:etag="W/&quot;1&quot;"'),
      entry("2026-07-14", { BC_10YEAR: "4.33" }, ' m:etag="W/&quot;2&quot;"'),
    ]);
    const { info } = adapter({ "2026": { body: withAttrs } });
    const outcome = await info.read(query("UST10Y"), guest).result;
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.last).toBe(4.33);
  });
});

describe("Treasury errors — a failure is never a value", () => {
  it("HTTP 500 → failed/upstream (retryable)", async () => {
    const { info } = adapter({ "2026": { status: 500, body: "" } });
    const outcome = await info.read(query("UST10Y"), guest).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("upstream");
    expect(outcome.degradation.retryable).toBe(true);
  });

  it("HTTP 404 → failed/invalid_response (URL scheme drift, not retryable)", async () => {
    const { info } = adapter({ "2026": { status: 404, body: "" } });
    const outcome = await info.read(query("UST10Y"), guest).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });

  it("non-XML garbage body → failed/invalid_response", async () => {
    const { info } = adapter({ "2026": { body: "<html>maintenance</html>" } });
    const outcome = await info.read(query("UST10Y"), guest).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });

  it("latest entry missing the tenor field → failed/invalid_response (no NaN value)", async () => {
    const missing = feed([
      entry("2026-07-13", { BC_2YEAR: "4.70", BC_10YEAR: "4.30" }),
      entry("2026-07-14", { BC_2YEAR: "4.75" }),
    ]);
    const { info } = adapter({ "2026": { body: missing } });
    const outcome = await info.read(query("UST10Y"), guest).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });

  it("transport throw → failed/timeout, never a rejected promise", async () => {
    const http: TreasuryHttp = async () => {
      throw new Error("socket reset");
    };
    const info = createPublicMarketInformation({ http, clock, config: CONFIG });
    const outcome = await info.read(query("UST10Y"), guest).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("timeout");
  });
});

describe("Treasury scope gates — zero network on out-of-scope reads", () => {
  it("unknown symbol → no_data without touching the wire", async () => {
    const { info, calls } = adapter({ "2026": { body: FIXTURE_2026 } });
    const outcome = await info.read(query("DOGE"), guest).result;
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("no_data");
    expect(calls.length).toBe(0);
  });

  it("prototype-chain symbols (constructor) are not tenors → no_data, zero network", async () => {
    const { info, calls } = adapter({ "2026": { body: FIXTURE_2026 } });
    const outcome = await info.read(query("constructor"), guest).result;
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("no_data");
    expect(calls.length).toBe(0);
  });

  it("non-public purpose → api_required without touching the wire", async () => {
    const { info, calls } = adapter({ "2026": { body: FIXTURE_2026 } });
    const outcome = await info.read(query("UST10Y", "personal_display"), guest).result;
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("api_required");
    expect(calls.length).toBe(0);
  });

  it("disabled composition serves api_required with zero network (egress gate)", async () => {
    const info = createDisabledPublicMarketInformation();
    const outcome = await info.read(query("UST10Y"), guest).result;
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("api_required");
  });
});

describe("Treasury year boundary — change is derived, never fabricated", () => {
  it("fewer than 2 entries in the current year → merges the previous year for the prior publication", async () => {
    const jan2 = Date.parse("2026-01-02T20:00:00.000Z");
    const janClock = { now: () => jan2, sleep: () => new Promise<void>(() => {}) };
    const { http, calls } = stubHttp({
      "2026": { body: feed([entry("2026-01-02", { BC_10YEAR: "4.10" })]) },
      "2025": { body: feed([entry("2025-12-31", { BC_10YEAR: "4.00" })]) },
    });
    const info = createPublicMarketInformation({ http, clock: janClock, config: CONFIG });

    const outcome = await info.read(query("UST10Y"), guest).result;

    expect(calls.length).toBe(2);
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.last).toBe(4.1);
    expect(outcome.value.change).toBeCloseTo(0.1, 10);
    expect(outcome.asOf).toBe("2026-01-02T00:00:00.000Z");
  });

  it("a single entry across both years → invalid_response (change would be a fabricated number)", async () => {
    const jan2 = Date.parse("2026-01-02T20:00:00.000Z");
    const janClock = { now: () => jan2, sleep: () => new Promise<void>(() => {}) };
    const { http } = stubHttp({
      "2026": { body: feed([entry("2026-01-02", { BC_10YEAR: "4.10" })]) },
      "2025": { body: feed([]) },
    });
    const info = createPublicMarketInformation({ http, clock: janClock, config: CONFIG });

    const outcome = await info.read(query("UST10Y"), guest).result;

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("invalid_response");
  });
});

describe("Treasury deadline self-guarantee", () => {
  it("a hung transport resolves to a timeout outcome — no infinite spinner", async () => {
    const http: TreasuryHttp = () => new Promise(() => {});
    const immediate = { now: () => NOW, sleep: () => Promise.resolve() };
    const info = createPublicMarketInformation({ http, clock: immediate, config: CONFIG });

    const outcome = await info.read(query("UST10Y"), guest).result;

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.degradation.code).toBe("timeout");
  });
});

describe("withTreasuryCache — upstream amplification bound", () => {
  const ok = { status: 200, body: "<feed/>" };

  function counting(response: () => Promise<{ status: number; body: string }>): { http: TreasuryHttp; count: () => number } {
    let calls = 0;
    return {
      http: () => {
        calls += 1;
        return response();
      },
      count: () => calls,
    };
  }

  it("repeated reads of one URL within TTL hit upstream once", async () => {
    const { http, count } = counting(() => Promise.resolve(ok));
    const cached = withTreasuryCache(http, () => 1_000, 60_000);
    await cached({ url: "u" });
    await cached({ url: "u" });
    expect(count()).toBe(1);
  });

  it("concurrent reads share one in-flight request (single-flight)", async () => {
    let release: (value: { status: number; body: string }) => void = () => {};
    const { http, count } = counting(() => new Promise((resolve) => (release = resolve)));
    const cached = withTreasuryCache(http, () => 1_000, 60_000);
    const [a, b] = [cached({ url: "u" }), cached({ url: "u" })];
    release(ok);
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect(count()).toBe(1);
  });

  it("expired TTL refetches", async () => {
    let nowMs = 0;
    const { http, count } = counting(() => Promise.resolve(ok));
    const cached = withTreasuryCache(http, () => nowMs, 60_000);
    await cached({ url: "u" });
    nowMs = 61_000;
    await cached({ url: "u" });
    expect(count()).toBe(2);
  });

  it("non-200 responses are not cached — the next read retries", async () => {
    const { http, count } = counting(() => Promise.resolve({ status: 500, body: "" }));
    const cached = withTreasuryCache(http, () => 1_000, 60_000);
    await cached({ url: "u" });
    await cached({ url: "u" });
    expect(count()).toBe(2);
  });

  it("rejections are not cached — the next read retries", async () => {
    const { http, count } = counting(() => Promise.reject(new Error("reset")));
    const cached = withTreasuryCache(http, () => 1_000, 60_000);
    await expect(cached({ url: "u" })).rejects.toThrow("reset");
    await expect(cached({ url: "u" })).rejects.toThrow("reset");
    expect(count()).toBe(2);
  });
});
