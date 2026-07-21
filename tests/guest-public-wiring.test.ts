import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { AvailableInformation } from "../src/shared";
import type {
  MarketInformation,
  MarketObservation,
  MarketQuery,
} from "../src/modules/financial-information/data/contracts";
import { createPublicFinancialInformation } from "../src/modules/terminal-view/presentation/guest/public-financial-information";
import { resolveGuestFeatureRuntime } from "../src/modules/terminal-view/presentation/guest/public-feature";
import type { GuestFinancialQuery } from "../src/modules/terminal-view/presentation/guest/contracts";
import type { GuestViewerContext } from "../src/shared/contracts/viewer-context";

// Ticket 30-a — the index-us10y strip cell reads the real treasury feed through an injected
// MarketInformation; every other panel keeps the honest F1 stub. 30-b — F1_GUEST_MODE lets dev
// opt into the public composition for QA without weakening the production/synthetic fence.

const guestViewer: GuestViewerContext = { kind: "guest", requestId: "req-1" };

function guestQuery(panelKey: GuestFinancialQuery["panelKey"]): GuestFinancialQuery {
  return { kind: "FinancialQuery", panelKey, purpose: "public_display", requestRevision: "r1" };
}

const evidence = brandReference<string, "EvidenceReference">("evidence:f4:UST10Y:treasury:daily-par-yield-curve");

const availableUst10y: AvailableInformation<MarketObservation> = {
  status: "available",
  value: {
    symbol: "UST10Y",
    last: 4.33,
    currency: "%",
    change: 0.03,
    changePercent: 0.7,
    priceBasis: "eod",
    evidenceReference: evidence,
  },
  evidenceReference: evidence,
  provider: "treasury",
  feed: "treasury:daily-par-yield-curve",
  asOf: "2026-07-14T00:00:00.000Z",
  receivedAt: "2026-07-14T20:00:00.000Z",
  freshness: "realtime",
  licenseScope: { audience: "public", purposes: ["public_display"], validUntil: "2099-01-01T00:00:00.000Z" },
  policyVersion: brandReference<string, "PolicyVersion">("policy:f4-freshness-v1"),
};

function stubMarket(outcome: Awaited<ReturnType<MarketInformation["read"]>["result"]>): {
  market: MarketInformation;
  reads: MarketQuery[];
} {
  const reads: MarketQuery[] = [];
  const market: MarketInformation = {
    read(query: MarketQuery) {
      reads.push(query);
      return { kind: "FinancialLoad", cache: "miss", query, result: Promise.resolve(outcome) };
    },
    follow() {
      return { async *[Symbol.asyncIterator]() { return; } };
    },
  };
  return { market, reads };
}

describe("guest index-us10y cell — treasury wiring (30-a)", () => {
  it("maps an available UST10Y observation to a guest panel value with provenance intact", async () => {
    const { market, reads } = stubMarket(availableUst10y);
    const info = createPublicFinancialInformation({ market });

    const outcome = await info.read(guestQuery("index-us10y"), guestViewer).result;

    expect(reads.length).toBe(1);
    expect(reads[0]?.symbol).toBe("UST10Y");
    expect(reads[0]?.purpose).toBe("public_display");
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.displayValue).toBe("4.33%");
    expect(outcome.value.label).toBe("미국 10Y");
    expect(outcome.provider).toBe("treasury");
    expect(outcome.freshness).toBe("realtime");
    expect(outcome.asOf).toBe("2026-07-14T00:00:00.000Z");
    expect(outcome.licenseScope.audience).toBe("public");
  });

  it("passes a value-free outcome through unchanged — no fabricated display value", async () => {
    const failed = {
      status: "failed",
      degradation: {
        code: "timeout",
        provider: "treasury",
        occurredAt: "2026-07-14T20:00:00.000Z",
        retryable: true,
        diagnosticReference: brandReference<string, "DiagnosticReference">("diagnostic:f4-timeout:treasury"),
      },
      policyVersion: brandReference<string, "PolicyVersion">("policy:f4-freshness-v1"),
    } as const;
    const { market } = stubMarket(failed);
    const info = createPublicFinancialInformation({ market });

    const outcome = await info.read(guestQuery("index-us10y"), guestViewer).result;

    expect(outcome).toEqual(failed);
  });

  it("keeps the honest api_required stub when no market is injected", async () => {
    const info = createPublicFinancialInformation();
    const outcome = await info.read(guestQuery("index-us10y"), guestViewer).result;
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("api_required");
  });

  it("never routes other panels to the treasury feed", async () => {
    const { market, reads } = stubMarket(availableUst10y);
    const info = createPublicFinancialInformation({ market });

    const outcome = await info.read(guestQuery("index-kospi"), guestViewer).result;

    expect(reads.length).toBe(0);
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("api_required");
  });
});

describe("guest filings panel — DART wiring (33-b)", () => {
  const filingOutcome = {
    status: "available",
    value: {
      kind: "filing",
      filings: [
        {
          form: "주요사항보고서",
          source: "삼성전자",
          filedAt: "2026-07-21T00:00:00.000Z",
          accession: "20260721000123",
          link: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260721000123",
          evidenceReference: brandReference<string, "EvidenceReference">("evidence:f4:filing:20260721000123"),
        },
      ],
    },
    evidenceReference: brandReference<string, "EvidenceReference">("evidence:f4:filing-list:dart"),
    provider: "dart",
    feed: "dart:latest-list",
    asOf: "2026-07-21T05:00:00.000Z",
    receivedAt: "2026-07-21T05:00:00.000Z",
    freshness: "realtime",
    licenseScope: { audience: "public", purposes: ["public_display"], validUntil: "2099-01-01T00:00:00.000Z" },
    policyVersion: brandReference<string, "PolicyVersion">("policy:f4-freshness-v1"),
  } as const;

  it("maps the most recent filing to one honest display line", async () => {
    const info = createPublicFinancialInformation({
      filings: { readRecent: async () => filingOutcome },
    });

    const outcome = await info.read(guestQuery("filings"), guestViewer).result;

    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.displayValue).toBe("삼성전자 · 주요사항보고서");
    expect(outcome.provider).toBe("dart");
    expect(outcome.licenseScope.audience).toBe("public");
  });

  it("keeps the honest api_required stub when no filings source is injected", async () => {
    const info = createPublicFinancialInformation();
    const outcome = await info.read(guestQuery("filings"), guestViewer).result;
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("api_required");
  });

  it("truncates a long filing line for display only (panel type scale)", async () => {
    const long = {
      ...filingOutcome,
      value: {
        kind: "filing" as const,
        filings: [{ ...filingOutcome.value.filings[0]!, form: "임원ㆍ주요주주특정증권등소유상황보고서및장문의보고서명이계속이어지는경우" }],
      },
    };
    const info = createPublicFinancialInformation({ filings: { readRecent: async () => long } });
    const outcome = await info.read(guestQuery("filings"), guestViewer).result;
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.displayValue.length).toBeLessThanOrEqual(40);
    expect(outcome.value.displayValue.endsWith("…")).toBe(true);
  });
});

describe("guest runtime mode override (30-b)", () => {
  it("F1_GUEST_MODE=public opts dev into the public composition", () => {
    expect(resolveGuestFeatureRuntime("development", undefined, "development", "public")).toEqual({
      environment: "development",
      mode: "public",
    });
  });

  it("an unknown override value keeps the default synthetic composition", () => {
    expect(resolveGuestFeatureRuntime("development", "0", "development", "banana")).toEqual({
      environment: "development",
      mode: "synthetic",
      scriptedHitDelayMs: 0,
    });
  });

  it("production stays public regardless of override (synthetic fence intact)", () => {
    expect(resolveGuestFeatureRuntime("production", undefined, "production", "synthetic")).toEqual({
      environment: "production",
      mode: "public",
    });
  });
});
