import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type {
  MarketInformation,
  MarketObservation,
  MarketQuery,
} from "../src/modules/financial-information/data/contracts";
import { createPersonalFinancialInformation } from "../src/modules/terminal-view/presentation/guest/personal-financial-information";
import { createPublicFinancialInformation } from "../src/modules/terminal-view/presentation/guest/public-financial-information";
import type { GuestFinancialQuery } from "../src/modules/terminal-view/presentation/guest/contracts";
import type { GuestViewerContext, WorkspaceViewerContext } from "../src/shared/contracts/viewer-context";
import type { AvailableInformation } from "../src/shared";

// Ticket 36 — 로그인 터미널이 본체다. 같은 포트에 개인(KIS) 소스를 drop-in 하되, 개인 값이
// 게스트 경로로 새지 않는 것(map line 16)이 핵심 불변식이다.

const guestViewer: GuestViewerContext = { kind: "guest", requestId: "req-guest" };

function ownerViewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-owner",
    workspaceReference: brandReference<string, "WorkspaceReference">("workspace:owner"),
    accountReference: brandReference<string, "AccountReference">("account:owner"),
    sessionReference: brandReference<string, "SessionReference">("session:owner"),
    sessionGeneration: brandReference<string, "SessionGeneration">("1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("1"),
    membershipRevision: brandReference<string, "MembershipRevision">("1"),
  };
}

function query(panelKey: GuestFinancialQuery["panelKey"]): GuestFinancialQuery {
  return { kind: "FinancialQuery", panelKey, purpose: "public_display", requestRevision: "r1" };
}

const evidence = brandReference<string, "EvidenceReference">("evidence:f4:KOSPI:kis:domestic-quote");

function kospi(): AvailableInformation<MarketObservation> {
  return {
    status: "available",
    value: {
      symbol: "KOSPI",
      last: 6747.95,
      currency: "pt",
      change: 231.68,
      changePercent: 3.56,
      priceBasis: "eod",
      evidenceReference: evidence,
    },
    evidenceReference: evidence,
    provider: "kis",
    feed: "kis:domestic-quote",
    asOf: "2026-07-21T06:30:00.000Z",
    receivedAt: "2026-07-21T09:00:00.000Z",
    freshness: "stale",
    licenseScope: { audience: "personal", purposes: ["personal_display"], validUntil: "2027-01-01T00:00:00.000Z" },
    policyVersion: brandReference<string, "PolicyVersion">("policy:f4-freshness-v1"),
  };
}

function recordingMarket(): { market: MarketInformation; reads: { query: MarketQuery; viewerKind: string }[] } {
  const reads: { query: MarketQuery; viewerKind: string }[] = [];
  const market: MarketInformation = {
    read(marketQuery, viewer) {
      reads.push({ query: marketQuery, viewerKind: viewer.kind });
      return { kind: "FinancialLoad", cache: "miss", query: marketQuery, result: Promise.resolve(kospi()) };
    },
    follow() {
      return { async *[Symbol.asyncIterator]() { return; } };
    },
  };
  return { market, reads };
}

describe("personal terminal source (36)", () => {
  it("reads a wired panel through the owner viewer with personal_display purpose", async () => {
    const { market, reads } = recordingMarket();
    const info = createPersonalFinancialInformation({
      market,
      viewer: ownerViewer(),
      fallback: createPublicFinancialInformation(),
    });

    const outcome = await info.read(query("index-kospi"), guestViewer).result;

    expect(reads).toHaveLength(1);
    expect(reads[0]?.query.symbol).toBe("KOSPI");
    // 게스트 뷰어가 인자로 들어와도 개인 read는 세션에서 확정된 owner 뷰어로만 나간다.
    expect(reads[0]?.query.purpose).toBe("personal_display");
    expect(reads[0]?.viewerKind).toBe("workspace");
    expect(outcome.status).toBe("available");
    if (outcome.status !== "available") throw new Error("unreachable");
    expect(outcome.value.displayValue).toBe("6,747.95");
    expect(outcome.value.label).toBe("코스피");
    expect(outcome.licenseScope.audience).toBe("personal");
  });

  it("falls back to the public source for panels KIS cannot serve", async () => {
    const { market, reads } = recordingMarket();
    const info = createPersonalFinancialInformation({
      market,
      viewer: ownerViewer(),
      fallback: createPublicFinancialInformation(),
    });

    const outcome = await info.read(query("index-sp500"), guestViewer).result;

    expect(reads).toHaveLength(0); // 개인 키가 미배선 패널 때문에 네트워크를 타지 않는다
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("api_required");
  });

  it("passes a value-free personal outcome through unchanged", async () => {
    const failed = {
      status: "failed",
      degradation: {
        code: "quota",
        provider: "kis",
        occurredAt: "2026-07-21T09:00:00.000Z",
        retryable: true,
        diagnosticReference: brandReference<string, "DiagnosticReference">("diagnostic:f4-quota:kis"),
      },
      policyVersion: brandReference<string, "PolicyVersion">("policy:f4-freshness-v1"),
    } as const;
    const market: MarketInformation = {
      read(marketQuery) {
        return { kind: "FinancialLoad", cache: "miss", query: marketQuery, result: Promise.resolve(failed) };
      },
      follow() {
        return { async *[Symbol.asyncIterator]() { return; } };
      },
    };
    const info = createPersonalFinancialInformation({
      market,
      viewer: ownerViewer(),
      fallback: createPublicFinancialInformation(),
    });

    expect(await info.read(query("index-kospi"), guestViewer).result).toEqual(failed);
  });
});
