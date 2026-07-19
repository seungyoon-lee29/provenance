import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../../src/composition/runtime-policy";

/**
 * Standing invariant (ticket 21, map Decisions, spec out-of-scope, ADR 0004):
 * Live Trading order transmission and paid composition can never boot. The
 * fail-closed runtime policy is the single gate; these properties bind it over
 * every environment so a future edit that re-enables live/paid fails here.
 */

const ENVIRONMENTS = ["development", "test", "staging", "production"] as const;

function baseEnv(environment: (typeof ENVIRONMENTS)[number]): Record<string, string> {
  const secure = environment === "production" || environment === "staging";
  return {
    APP_ENVIRONMENT: environment,
    APP_PUBLIC_ORIGIN: secure ? "https://app.example.com" : "http://localhost:3000",
    PROVIDER_BILLING_MODE: "free_only",
    LOCAL_PROVIDER_CREDENTIAL_MODE: "contract_only",
    CREDENTIAL_VAULT_PROVIDER: "disabled",
  };
}

describe("no-live-route / no-paid-composition invariant", () => {
  it("loads cleanly in every environment WITHOUT live trading (baseline is valid)", () => {
    fc.assert(fc.property(fc.constantFrom(...ENVIRONMENTS), (environment) => {
      expect(() => loadRuntimeConfig(baseEnv(environment))).not.toThrow();
    }));
  });

  it("rejects ENABLE_LIVE_TRADING=true in every environment", () => {
    fc.assert(fc.property(fc.constantFrom(...ENVIRONMENTS), (environment) => {
      expect(() => loadRuntimeConfig({ ...baseEnv(environment), ENABLE_LIVE_TRADING: "true" })).toThrow();
    }));
  });

  it("rejects any non-empty paid adapter/route/schedule composition", () => {
    const nonEmpty = fc.string({ minLength: 1 }).filter((value) => value.trim().length > 0);
    fc.assert(fc.property(fc.constantFrom("ADAPTERS", "ROUTES", "SCHEDULES"), nonEmpty, (which, value) => {
      expect(() => loadRuntimeConfig({ ...baseEnv("development"), [`ENABLED_PAID_${which}`]: value })).toThrow();
    }));
  });
});
