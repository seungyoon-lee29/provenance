import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F11 release readiness posture (spec §12.2, AC / interface contract): the
 * shipped default is network-off with every real-provider contract opt-in OFF
 * (honest `not_run`) and Live Trading disabled. This reads the committed
 * `.env.example` — the canonical shipped policy — not any local secret file.
 */

const ROOT = resolve(import.meta.dirname, "../..");

function envExample(): Map<string, string> {
  const entries = readFileSync(resolve(ROOT, ".env.example"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as const;
    });
  return new Map(entries);
}

// `.env.example` is excluded from the container image by `.dockerignore`; this
// is a source-policy check, so skip it when the file isn't present.
const envExamplePresent = existsSync(resolve(ROOT, ".env.example"));

describe.skipIf(!envExamplePresent)("F11 release readiness posture", () => {
  const env = envExamplePresent ? envExample() : new Map<string, string>();

  it("defaults every real-provider contract to not_run (opt-in off)", () => {
    const contractFlags = [...env.keys()].filter((key) => key.startsWith("RUN_") && key.endsWith("_CONTRACT"));
    expect(contractFlags.length).toBeGreaterThanOrEqual(6);
    for (const flag of contractFlags) expect(env.get(flag)).toBe("false");
  });

  it("ships with Live Trading disabled and free-only billing", () => {
    expect(env.get("ENABLE_LIVE_TRADING")).toBe("false");
    expect(env.get("PROVIDER_BILLING_MODE")).toBe("free_only");
    expect(env.get("LOCAL_PROVIDER_CREDENTIAL_MODE")).toBe("contract_only");
  });

  it("carries no non-empty credential value in the shipped example", () => {
    for (const key of ["GEMINI_API_KEY", "ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY", "KIS_APP_KEY", "KIS_APP_SECRET", "DART_API_KEY", "KRX_API_KEY", "GOOGLE_IDENTITY_CLIENT_SECRET", "GITHUB_IDENTITY_CLIENT_SECRET"]) {
      expect(env.get(key)).toBe("");
    }
  });
});
