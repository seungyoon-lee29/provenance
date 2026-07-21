import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { presentGuestPanel } from "../src/modules/terminal-view/presentation/guest/guest-panel-presenter";
import type { GuestPanelValue } from "../src/modules/terminal-view/presentation/guest/contracts";
import type { InformationOutcome } from "../src/shared";

// Ticket 35 — provenance는 기본 숨김이 되고, 평소 화면에는 값 + 한 줄 요약(출처·신선도·시각)만
// 남는다. 요약은 available일 때만 만든다: 값이 없는 outcome에 출처 줄을 지어내지 않는다.

const policyVersion = brandReference<string, "PolicyVersion">("policy:f4-freshness-v1");
const evidence = brandReference<string, "EvidenceReference">("evidence:f4:UST10Y:treasury");

function available(overrides: Partial<{ provider: string; freshness: "realtime" | "delayed" | "stale"; asOf: string }>): InformationOutcome<GuestPanelValue> {
  return {
    status: "available",
    value: { label: "미국 10Y", displayValue: "4.6%" },
    evidenceReference: evidence,
    provider: overrides.provider ?? "treasury",
    feed: "treasury:daily-par-yield-curve",
    asOf: overrides.asOf ?? "2026-07-20T00:00:00.000Z",
    receivedAt: "2026-07-21T09:00:00.000Z",
    freshness: overrides.freshness ?? "realtime",
    licenseScope: { audience: "public", purposes: ["public_display"], validUntil: "2099-01-01T00:00:00.000Z" },
    policyVersion,
  };
}

function present(outcome: InformationOutcome<GuestPanelValue>) {
  return presentGuestPanel({ state: "ready", outcome, requestRevision: "r1" });
}

describe("guest panel summary line (35)", () => {
  it("summarizes a daily publication as 출처 · 신선도 · 날짜 (자정 UTC는 시각 노이즈를 붙이지 않는다)", () => {
    expect(present(available({})).summary).toBe("treasury · 실시간 · 2026-07-20");
  });

  it("keeps the clock for an intraday observation, and marks the zone", () => {
    const outcome = available({ provider: "kis", freshness: "stale", asOf: "2026-07-21T06:30:00.000Z" });
    expect(present(outcome).summary).toBe("kis · 오래됨 · 2026-07-21 06:30 UTC");
  });

  it("keeps '갱신 지연' in the one line — the fact stays visible, the codes move to the toggle", () => {
    const degraded = {
      ...available({ provider: "kis", freshness: "stale", asOf: "2026-07-21T06:30:00.000Z" }),
      degradation: {
        code: "timeout" as const,
        provider: "kis",
        occurredAt: "2026-07-21T09:00:00.000Z",
        retryable: true,
        diagnosticReference: brandReference<string, "DiagnosticReference">("diagnostic:f4-soft-expiry:kis"),
      },
    };
    expect(present(degraded).summary).toBe("kis · 오래됨 · 2026-07-21 06:30 UTC · 갱신 지연");
  });

  it("never invents a source line for a value-free outcome", () => {
    const apiRequired: InformationOutcome<GuestPanelValue> = {
      status: "unavailable",
      reason: "api_required",
      requiredCapability: "public_watchlist",
      configurationRoute: "/settings/providers",
      policyVersion,
    };
    const view = present(apiRequired);
    expect(view.summary).toBeUndefined();
    expect(view).not.toHaveProperty("primaryValue");
  });

  it("keeps the full provenance available for the toggle (nothing is dropped)", () => {
    const view = present(available({}));
    expect(view.provenance.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(["Evidence Reference", "Provider", "Feed", "As of", "Data Freshness", "License Scope", "Policy Version"]),
    );
  });
});
