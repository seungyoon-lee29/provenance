import { describe, expect, it } from "vitest";

import {
  catalogClock,
  createScriptedMarketInformation,
  loadSyntheticMarketCatalog,
} from "../src/modules/financial-information/data/scripted-market-information";
import type { MarketQuery } from "../src/modules/financial-information/data/contracts";
import type { InformationOutcome } from "../src/shared/contracts/information-outcome";
import type { MarketObservation } from "../src/modules/financial-information/data/contracts";

// Blind acceptance test (AT-01). Expectations below are derived INDEPENDENTLY
// from spec §5.1, NOT from the implementation. Each case's `expected` field in
// the fixture is treated as a CLAIM: we assert our own spec-derivation, then
// deep-equal against `expected` as a cross-check.

const catalog = loadSyntheticMarketCatalog();
const NOW = Date.parse(catalog.now); // 2026-01-02T14:30:00.000Z

type RawCase = (typeof catalog)["cases"][number];

function query(symbol: string): MarketQuery {
  return { kind: "FinancialQuery", symbol, purpose: "public_display", requestRevision: "r0" };
}

async function read(symbol: string, id: string): Promise<InformationOutcome<MarketObservation>> {
  const info = createScriptedMarketInformation(catalogClock());
  return info.read(query(symbol), { kind: "guest", requestId: "req-" + id }).result;
}

// --- Independent spec derivation --------------------------------------------

type Expectation =
  | { status: "available"; freshness: "realtime" | "delayed" | "stale"; softExpired: boolean; priceBasis: string }
  | { status: "unavailable"; reason: "api_required" | "license_restricted" | "no_data" }
  | { status: "failed"; code: string; retryable: boolean; hasRetryAfter: boolean };

function residualFreshness(ageMs: number, p: { declaredDelayMs: number; softResidualMs: number; hardResidualMs: number }):
  | "realtime"
  | "delayed"
  | "stale"
  | "hard" {
  const { declaredDelayMs: d, softResidualMs: s, hardResidualMs: h } = p;
  if (ageMs <= d) return "realtime";
  if (ageMs < d + s) return "delayed";
  if (ageMs < d + h) return "stale";
  return "hard";
}

function cadenceFreshness(ageMs: number, p: { cadenceMs: number; softGraceMs: number; hardMissedPublications: number }):
  | "realtime"
  | "delayed"
  | "stale"
  | "hard" {
  if (ageMs < p.cadenceMs) return "realtime";
  if (ageMs < p.cadenceMs + p.softGraceMs) return "delayed";
  if (ageMs < p.cadenceMs * p.hardMissedPublications) return "stale";
  return "hard";
}

// Derive the outcome shape from the raw scenario + spec §5.1, ignoring `expected`.
function derive(c: RawCase): Expectation {
  const s = c.scenario;
  switch (s.type) {
    case "observation": {
      // malformed payload or future timestamp => failed/invalid_response (terminal).
      if (s.malform) return { status: "failed", code: "invalid_response", retryable: false, hasRetryAfter: false };
      const asOf = Date.parse(s.asOf);
      if (asOf > NOW) return { status: "failed", code: "invalid_response", retryable: false, hasRetryAfter: false };
      const age = NOW - asOf;
      const fresh = s.policy.kind === "residual" ? residualFreshness(age, s.policy) : cadenceFreshness(age, s.policy);
      if (fresh === "hard") return { status: "unavailable", reason: "no_data" };
      return { status: "available", freshness: fresh, softExpired: fresh === "stale", priceBasis: s.value.priceBasis };
    }
    case "api_required":
      return { status: "unavailable", reason: "api_required" };
    case "no_data":
      return { status: "unavailable", reason: "no_data" };
    case "failure": {
      const f = s.failure;
      switch (f.kind) {
        case "reauthentication_required":
          return { status: "failed", code: "reauthentication_required", retryable: false, hasRetryAfter: false };
        case "denied":
          // 403 entitlement/display denial => unavailable/license_restricted.
          if (f.denial === "entitlement") return { status: "unavailable", reason: "license_restricted" };
          // 403 credential/account-auth denial => failed/reauthentication_required.
          if (f.denial === "credential")
            return { status: "failed", code: "reauthentication_required", retryable: false, hasRetryAfter: false };
          // 403 other => failed/forbidden_upstream.
          return { status: "failed", code: "forbidden_upstream", retryable: false, hasRetryAfter: false };
        case "quota":
          return { status: "failed", code: "quota", retryable: true, hasRetryAfter: true };
        case "timeout":
          return { status: "failed", code: "timeout", retryable: true, hasRetryAfter: false };
        case "upstream":
          return { status: "failed", code: "upstream", retryable: true, hasRetryAfter: false };
        case "invalid_response":
          return { status: "failed", code: "invalid_response", retryable: false, hasRetryAfter: false };
      }
    }
  }
}

const REQUIRED_AVAILABLE_FIELDS = [
  "evidenceReference",
  "provider",
  "feed",
  "asOf",
  "receivedAt",
  "freshness",
  "licenseScope",
  "policyVersion",
] as const;

describe("F4 scripted market information — AT-01 blind acceptance", () => {
  for (const c of catalog.cases) {
    it(`${c.id}: outcome matches spec-derived expectation`, async () => {
      const outcome = await read(c.symbol, c.id);
      const exp = derive(c);

      expect(outcome.status).toBe(exp.status);

      // policyVersion is a REQUIRED field on every outcome variant per the
      // public type contract (information-outcome.ts). Spec-derived, not
      // read from the impl.
      expect((outcome as { policyVersion?: unknown }).policyVersion, "policyVersion required on every outcome").toBeTruthy();

      // AT-01 invariant: value exists IFF available.
      if (exp.status === "available") {
        expect("value" in outcome).toBe(true);
      } else {
        expect("value" in outcome && (outcome as { value?: unknown }).value).toBeFalsy();
      }

      if (exp.status === "available") {
        if (outcome.status !== "available") throw new Error("unreachable");
        expect(outcome.freshness).toBe(exp.freshness);
        expect(outcome.value.symbol).toBe(c.symbol);
        expect(outcome.value.priceBasis).toBe(exp.priceBasis);
        // Provenance present (§5.1 + AT-01).
        for (const field of REQUIRED_AVAILABLE_FIELDS) {
          expect(outcome[field], `missing provenance field ${field}`).toBeTruthy();
        }
        expect(outcome.value.evidenceReference).toBe(outcome.evidenceReference);
        // Soft-expired ⇒ stale + retryable degradation.
        if (exp.softExpired) {
          expect(outcome.freshness).toBe("stale");
          expect(outcome.degradation).toBeDefined();
          expect(outcome.degradation?.retryable).toBe(true);
        }
      }

      if (exp.status === "unavailable") {
        if (outcome.status !== "unavailable") throw new Error("unreachable");
        expect(outcome.reason).toBe(exp.reason);
        if (outcome.reason === "api_required") {
          expect(outcome.requiredCapability).toBeTruthy();
          expect(outcome.configurationRoute).toBeTruthy();
        } else if (outcome.reason === "license_restricted") {
          expect(outcome.source).toBeTruthy();
          expect(outcome.purpose).toBeTruthy();
        } else {
          expect(outcome.queryRange).toBeTruthy();
          expect(outcome.asOf).toBeTruthy();
        }
      }

      if (exp.status === "failed") {
        if (outcome.status !== "failed") throw new Error("unreachable");
        const d = outcome.degradation;
        expect(d.code).toBe(exp.code);
        expect(d.retryable).toBe(exp.retryable);
        // retryAfter present only for quota.
        expect(d.retryAfter === undefined).toBe(!exp.hasRetryAfter);
        // SEC-05: diagnosticReference is a `diagnostic:`-prefixed handle, not raw error text.
        expect(d.diagnosticReference.startsWith("diagnostic:")).toBe(true);
        expect(d.provider).toBeTruthy();
      }

      // Cross-check against the fixture's claimed `expected` (deep equality).
      expect(outcome).toEqual(c.expected);
    });
  }

  it("AT-01 invariant: value only on available, every available carries evidenceReference", async () => {
    for (const c of catalog.cases) {
      const outcome = await read(c.symbol, c.id);
      if (outcome.status === "available") {
        expect(outcome.value).toBeDefined();
        expect(outcome.evidenceReference).toBeTruthy();
        expect(outcome.value.evidenceReference).toBeTruthy();
      } else {
        expect("value" in outcome && (outcome as { value?: unknown }).value).toBeFalsy();
      }
    }
  });

  it("unknown symbol resolves to unavailable/no_data", async () => {
    const outcome = await read("__NOT_IN_CATALOG__", "unknown");
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toBe("no_data");
    expect("value" in outcome && (outcome as { value?: unknown }).value).toBeFalsy();
  });
});
