import { describe, expect, it } from "vitest";

import { presentGuestPanel } from "../src/modules/terminal-view/presentation/guest/guest-panel-presenter";
import { loadSyntheticGuestFixture } from "../src/modules/terminal-view/presentation/guest/scripted-financial-information";

describe("guest terminal literal Information Outcomes", () => {
  it("renders a primary value and the complete provenance only for available outcomes", () => {
    const fixture = loadSyntheticGuestFixture();
    expect(fixture.marker).toBe("SYNTHETIC TEST DATA");
    expect(fixture.isSynthetic).toBe(true);

    for (const fixtureCase of fixture.cases) {
      const view = presentGuestPanel({ state: "ready", outcome: fixtureCase.outcome, requestRevision: "r1" });
      if (fixtureCase.outcome.status === "available") {
        expect(view.primaryValue).toBe(fixtureCase.outcome.value.displayValue);
        expect(view.provenance.map((entry) => entry.label)).toEqual(expect.arrayContaining([
          "Evidence Reference", "Provider", "Feed", "Venue", "As of", "Received at",
          "Data Freshness", "License Scope", "Policy Version",
        ]));
      } else {
        expect(view).not.toHaveProperty("primaryValue");
      }
    }
  });

  it.each([
    ["api_required", "API 필요"],
    ["license_restricted", "표시 권한 없음"],
    ["no_data", "데이터 없음"],
    ["failed_retryable", "공급자 응답 실패 · 재시도 가능"],
    ["failed_terminal", "공급자 응답 오류 · 자동 재시도 없음"],
  ])("uses an honest Korean label for %s", (id, label) => {
    const fixtureCase = loadSyntheticGuestFixture().cases.find((candidate) => candidate.id === id);
    expect(fixtureCase).toBeDefined();
    if (!fixtureCase) return;
    expect(presentGuestPanel({ state: "ready", outcome: fixtureCase.outcome, requestRevision: "r1" }).statusLabel).toBe(label);
  });
});
