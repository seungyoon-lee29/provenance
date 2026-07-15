import { describe, expect, it } from "vitest";

import { createScriptedEvidenceResolver, loadSyntheticEvidenceCatalog } from "../src/modules/financial-information/data/scripted-evidence-resolver";
import { applyEvidenceFreshness, isMalformedEvidence } from "../src/modules/financial-information/data/evidence-normalization";
import type { EvidenceValue } from "../src/modules/financial-information/data/evidence-contracts";
import type { ObservationExpiryPolicy } from "../src/modules/financial-information/data/contracts";
import type { AvailableInformation } from "@/shared";
import type { EvidenceReference } from "@/shared";
import type { ViewerContext } from "@/shared/contracts/viewer-context";

const NOW = Date.parse("2026-01-02T14:30:00.000Z");
const guest: ViewerContext = { kind: "guest", requestId: "req-f4-evidence" };

describe("isMalformedEvidence", () => {
  it("rejects empty sets, missing fields, and future/non-canonical timestamps", () => {
    expect(isMalformedEvidence({ kind: "news", headlines: [] }, NOW)).toBe(true);
    expect(isMalformedEvidence({ kind: "news", headlines: [{ title: "", source: "s", publishedAt: "2026-01-02T14:00:00.000Z", link: "l", evidenceReference: "e" as never }] }, NOW)).toBe(true);
    expect(isMalformedEvidence({ kind: "news", headlines: [{ title: "t", source: "s", publishedAt: "2026-01-02T14:35:00.000Z", link: "l", evidenceReference: "e" as never }] }, NOW)).toBe(true);
    expect(isMalformedEvidence({ kind: "news", headlines: [{ title: "t", source: "s", publishedAt: "2026-01-02T14:00:00.000Z", link: "l", evidenceReference: "e" as never }] }, NOW)).toBe(false);
  });
});

function availableNews(publishedAt: string): AvailableInformation<EvidenceValue> {
  const value: EvidenceValue = { kind: "news", headlines: [{ title: "t", source: "s", publishedAt, link: "https://x.test/1", evidenceReference: "evidence:test" as never }] };
  return {
    status: "available", value, evidenceReference: "evidence:test" as never,
    provider: "synthetic", feed: "fixture-news", venue: "SYNTHETIC",
    asOf: publishedAt, receivedAt: new Date(NOW).toISOString(), freshness: "realtime",
    licenseScope: { audience: "internal_test_only", purposes: ["ai_research"], validUntil: "2027-01-01T00:00:00.000Z" },
    policyVersion: "policy:test" as never,
  };
}

describe("applyEvidenceFreshness (reuses the shared classifier)", () => {
  // cadence: 15min interval, 5min grace, 2 missed → hard at 30min (hand-derived).
  const policy: ObservationExpiryPolicy = { kind: "cadence", cadenceMs: 900_000, softGraceMs: 300_000, hardMissedPublications: 2 };
  it("fresh within cadence, stale in the grace band, hard-expired past N publications", () => {
    expect(applyEvidenceFreshness(availableNews(new Date(NOW - 10 * 60_000).toISOString()), { nowMs: NOW, policy }).status).toBe("available");
    const stale = applyEvidenceFreshness(availableNews(new Date(NOW - 22 * 60_000).toISOString()), { nowMs: NOW, policy });
    expect(stale.status).toBe("available");
    if (stale.status === "available") expect(stale.freshness).toBe("stale");
    const hard = applyEvidenceFreshness(availableNews(new Date(NOW - 40 * 60_000).toISOString()), { nowMs: NOW, policy });
    expect(hard.status).toBe("unavailable");
    expect("value" in hard && hard.value).toBeFalsy();
  });
  it("quarantines a future-dated headline as invalid_response", () => {
    const out = applyEvidenceFreshness(availableNews(new Date(NOW + 60_000).toISOString()), { nowMs: NOW, policy });
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.degradation.code).toBe("invalid_response");
  });
});

describe("EvidenceResolver seam (§6.1) — purpose-bound, value only on available", () => {
  const resolver = createScriptedEvidenceResolver();
  const catalog = loadSyntheticEvidenceCatalog();

  const expectedById: Record<string, (o: Awaited<ReturnType<typeof resolver.resolve>>) => void> = {
    news_fresh: (o) => { expect(o.status).toBe("available"); if (o.status === "available") { expect(o.freshness).toBe("realtime"); expect(o.value.kind).toBe("news"); } },
    filing_stale: (o) => { expect(o.status).toBe("available"); if (o.status === "available") { expect(o.freshness).toBe("stale"); expect(o.degradation?.retryable).toBe(true); } },
    news_hard_expired: (o) => { expect(o.status).toBe("unavailable"); expect("value" in o && o.value).toBeFalsy(); },
    news_malformed_future: (o) => { expect(o.status).toBe("failed"); if (o.status === "failed") expect(o.degradation.code).toBe("invalid_response"); },
    filing_license_restricted: (o) => { expect(o).toMatchObject({ status: "unavailable", reason: "license_restricted" }); },
    news_no_data: (o) => { expect(o).toMatchObject({ status: "unavailable", reason: "no_data" }); },
  };

  for (const entry of catalog.cases) {
    it(`resolves ${entry.id} per spec §5.1`, async () => {
      const outcome = await resolver.resolve(entry.reference as EvidenceReference, entry.purpose, guest);
      expectedById[entry.id]!(outcome);
      // AT-01 invariant: a value exists iff available.
      if (outcome.status !== "available") expect("value" in outcome && (outcome as { value?: unknown }).value).toBeFalsy();
    });
  }

  it("unknown reference → no_data, and a non-licensed purpose → license_restricted", async () => {
    const unknown = await resolver.resolve("evidence:f4:news:MISSING" as EvidenceReference, "ai_research", guest);
    expect(unknown).toMatchObject({ status: "unavailable", reason: "no_data" });
    const wrongPurpose = await resolver.resolve("evidence:f4:news:AAA" as EvidenceReference, "derivative_export", guest);
    expect(wrongPurpose).toMatchObject({ status: "unavailable", reason: "license_restricted" });
  });
});
