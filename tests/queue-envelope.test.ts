import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { parseJobEnvelope, serializeJobEnvelope, type JobEnvelope } from "../src/shared/queue";

const valid: JobEnvelope = {
  schemaVersion: 1,
  jobReference: brandReference<string, "JobContextReference">("job-context-1"),
  purpose: "portfolio_sync",
  authorizationVersion: brandReference<string, "JobAuthorizationVersion">("auth-v1"),
};

describe("queue envelope", () => {
  it("round trips only opaque references", () => {
    expect(parseJobEnvelope(serializeJobEnvelope(valid))).toEqual(valid);
  });

  it.each(["viewerContext", "providerCredential", "accountIdentifier", "providerPayload"])("rejects forbidden %s payload", (field) => {
    const serialized = JSON.stringify({ ...valid, [field]: { secret: "sentinel" } });
    expect(() => parseJobEnvelope(serialized)).toThrow();
  });

  it("rejects malformed JSON and unknown purpose", () => {
    expect(() => parseJobEnvelope("not-json")).toThrow();
    expect(() => parseJobEnvelope(JSON.stringify({ ...valid, purpose: "raw_provider_call" }))).toThrow();
  });

  it("rejects an oversized envelope before parsing", () => {
    expect(() => parseJobEnvelope(JSON.stringify({ ...valid, padding: "x".repeat(5_000) }))).toThrow("maximum size");
  });
});
