import { describe, expect, it } from "vitest";

import { createResearchAssistant, containsForbiddenMaterial, narrowestLicenseScope } from "../src/modules/research-assistant/research-service";
import {
  consentEpoch,
  envelopeById,
  RecordingGeminiAdapter,
  RecordingLocalRule,
  scriptedMaterialResolver,
  staticConsent,
} from "../src/modules/research-assistant/scripted-research";
import type { AiConsentResolver, AiMaterialEnvelope, AiMaterialOutcome, LocalRuleEngine, ResearchResultShape, ResearchTaskShape } from "../src/modules/research-assistant/contracts";
import type { AiMaterialReference, InformationOutcome, ResearchResult } from "@/shared";
import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext, ViewerContext } from "@/shared/contracts/viewer-context";

const viewer: WorkspaceViewerContext = {
  kind: "workspace", requestId: "r1",
  workspaceReference: "workspace:w1" as never, accountReference: "account:a1" as never, sessionReference: "session:s1" as never,
  sessionGeneration: "gen:1" as never, accountAuthorizationEpoch: "authz:e1" as never, membershipRevision: "mem:1" as never,
};
const guest: ViewerContext = { kind: "guest", requestId: "g1" };

const GRANTED = { granted: true, allowsExternalProcessing: true, epoch: consentEpoch("consent:c1") };
const summarize: ResearchTaskShape = { kind: "ResearchTask", instruction: "Summarize.", mode: "summarize" };
const derive: ResearchTaskShape = { kind: "ResearchTask", instruction: "Write a note.", mode: "derive" };

function resolverFor(...envelopes: AiMaterialEnvelope[]) {
  const map = new Map<string, AiMaterialOutcome>();
  for (const e of envelopes) map.set(e.reference, { status: "available", value: e });
  return { resolver: scriptedMaterialResolver(map), refs: envelopes.map((e) => e.reference) };
}

const NO_LOCAL: LocalRuleEngine = {
  rulePolicyVersion: "policy:none" as never,
  supports: () => false,
  run: () => "",
};

function value(outcome: InformationOutcome<ResearchResult>) {
  return outcome.status === "available" ? (outcome.value as import("../src/modules/research-assistant/contracts").ResearchResultShape) : undefined;
}

describe("ResearchAssistant.run — §5.4 category/rights policy (AT-04)", () => {
  it("full-rights + consent + key → external Gemini, one call, no local", async () => {
    const adapter = new RecordingGeminiAdapter(true);
    const local = new RecordingLocalRule();
    const { resolver, refs } = resolverFor(envelopeById("mat_full"));
    const svc = createResearchAssistant({ materialResolver: resolver, consentResolver: staticConsent(GRANTED), adapter, localRule: local, now: () => 1_700_000_000_000 });
    const out = await svc.run(summarize, refs, viewer);
    expect(out.status).toBe("available");
    expect(value(out)?.producedBy).toBe("gemini");
    expect(adapter.callCount).toBe(1);
    expect(local.callCount).toBe(0);
  });

  it("derive on derivative-forbidden material → license_restricted, ZERO model + local calls", async () => {
    const adapter = new RecordingGeminiAdapter(true);
    const local = new RecordingLocalRule(true);
    const { resolver, refs } = resolverFor(envelopeById("mat_no_derivative"));
    const svc = createResearchAssistant({ materialResolver: resolver, consentResolver: staticConsent(GRANTED), adapter, localRule: local, now: () => 0 });
    const out = await svc.run(derive, refs, viewer);
    expect(out).toMatchObject({ status: "unavailable", reason: "license_restricted" });
    expect(adapter.callCount).toBe(0);
    expect(local.callCount).toBe(0);
  });

  it("external-processing forbidden → local rule when supported, ZERO Gemini calls", async () => {
    const adapter = new RecordingGeminiAdapter(true);
    const local = new RecordingLocalRule();
    const { resolver, refs } = resolverFor(envelopeById("mat_no_external"));
    const svc = createResearchAssistant({ materialResolver: resolver, consentResolver: staticConsent(GRANTED), adapter, localRule: local, now: () => 0 });
    const out = await svc.run(summarize, refs, viewer);
    expect(value(out)?.producedBy).toBe("local_rule");
    expect(adapter.callCount).toBe(0);
    expect(local.callCount).toBe(1);
  });

  it("external forbidden + no local support → license_restricted, zero calls", async () => {
    const adapter = new RecordingGeminiAdapter(true);
    const { resolver, refs } = resolverFor(envelopeById("mat_no_external"));
    const svc = createResearchAssistant({ materialResolver: resolver, consentResolver: staticConsent(GRANTED), adapter, localRule: NO_LOCAL, now: () => 0 });
    const out = await svc.run(summarize, refs, viewer);
    expect(out).toMatchObject({ status: "unavailable", reason: "license_restricted" });
    expect(adapter.callCount).toBe(0);
  });

  it("key absent → local rule when supported (no Gemini), else api_required/ai_model", async () => {
    const local = new RecordingLocalRule();
    const { resolver, refs } = resolverFor(envelopeById("mat_full"));
    const withLocal = createResearchAssistant({ materialResolver: resolver, consentResolver: staticConsent(GRANTED), adapter: new RecordingGeminiAdapter(false), localRule: local, now: () => 0 });
    expect(value(await withLocal.run(summarize, refs, viewer))?.producedBy).toBe("local_rule");

    const noLocal = createResearchAssistant({ materialResolver: resolver, consentResolver: staticConsent(GRANTED), adapter: new RecordingGeminiAdapter(false), localRule: NO_LOCAL, now: () => 0 });
    expect(await noLocal.run(summarize, refs, viewer)).toMatchObject({ status: "unavailable", reason: "api_required", requiredCapability: "ai_model" });
  });

  it("quota/timeout degraded → local rule + degradation, else failed", async () => {
    const { resolver, refs } = resolverFor(envelopeById("mat_full"));
    const degraded = new RecordingGeminiAdapter(true, { kind: "degraded", code: "quota", retryAfter: "2026-01-02T14:31:00.000Z" });
    const withLocal = createResearchAssistant({ materialResolver: resolver, consentResolver: staticConsent(GRANTED), adapter: degraded, localRule: new RecordingLocalRule(), now: () => 0 });
    const local = await withLocal.run(summarize, refs, viewer);
    expect(value(local)?.producedBy).toBe("local_rule");
    expect(value(local)?.degradation?.code).toBe("quota");

    const failedOut = await createResearchAssistant({ materialResolver: resolver, consentResolver: staticConsent(GRANTED), adapter: new RecordingGeminiAdapter(true, { kind: "degraded", code: "timeout" }), localRule: NO_LOCAL, now: () => 0 }).run(summarize, refs, viewer);
    expect(failedOut.status).toBe("failed");
    if (failedOut.status === "failed") expect(failedOut.degradation.code).toBe("timeout");
  });

  it("no consent / guest / empty refs are value-less with zero calls", async () => {
    const adapter = new RecordingGeminiAdapter(true);
    const { resolver, refs } = resolverFor(envelopeById("mat_full"));
    const base = { materialResolver: resolver, adapter, localRule: new RecordingLocalRule(), now: () => 0 };
    expect(await createResearchAssistant({ ...base, consentResolver: staticConsent({ ...GRANTED, granted: false }) }).run(summarize, refs, viewer)).toMatchObject({ status: "unavailable", reason: "api_required" });
    expect(await createResearchAssistant({ ...base, consentResolver: staticConsent(GRANTED) }).run(summarize, refs, guest)).toMatchObject({ status: "unavailable", reason: "api_required" });
    expect(await createResearchAssistant({ ...base, consentResolver: staticConsent(GRANTED) }).run(summarize, [], viewer)).toMatchObject({ status: "unavailable", reason: "no_data" });
    expect(adapter.callCount).toBe(0);
  });

  it("source-denied material → license_restricted, zero calls", async () => {
    const adapter = new RecordingGeminiAdapter(true);
    const ref = brandReference<string, "AiMaterialReference">("ai:f4:denied");
    const map = new Map<string, AiMaterialOutcome>([[ref, { status: "unavailable", reason: "license_restricted", source: "src", purpose: "ai_research", policyVersion: "p" as never }]]);
    const svc = createResearchAssistant({ materialResolver: scriptedMaterialResolver(map), consentResolver: staticConsent(GRANTED), adapter, localRule: new RecordingLocalRule(), now: () => 0 });
    expect(await svc.run(summarize, [ref], viewer)).toMatchObject({ status: "unavailable", reason: "license_restricted" });
    expect(adapter.callCount).toBe(0);
  });

  it("SEC-06: consent epoch bumped before dispatch blocks egress", async () => {
    const adapter = new RecordingGeminiAdapter(true);
    const env = envelopeById("mat_full");
    let calls = 0;
    // consent flips epoch after the run-start read, before the pre-dispatch recheck.
    const flipping: AiConsentResolver = { resolve: () => (calls++ === 0 ? GRANTED : { ...GRANTED, epoch: consentEpoch("consent:c2") }) };
    const map = new Map<string, AiMaterialOutcome>([[env.reference, { status: "available", value: env }]]);
    const svc = createResearchAssistant({ materialResolver: scriptedMaterialResolver(map), consentResolver: flipping, adapter, localRule: new RecordingLocalRule(), now: () => 0 });
    expect(await svc.run(summarize, [env.reference], viewer)).toMatchObject({ status: "unavailable", reason: "api_required" });
    expect(adapter.callCount).toBe(0);
  });

  it("redaction guard: material carrying a secret marker never reaches the model", async () => {
    const adapter = new RecordingGeminiAdapter(true);
    const { resolver, refs } = resolverFor(envelopeById("mat_leaky"));
    const svc = createResearchAssistant({ materialResolver: resolver, consentResolver: staticConsent(GRANTED), adapter, localRule: NO_LOCAL, now: () => 0 });
    const out = await svc.run(summarize, refs, viewer);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.degradation.code).toBe("invalid_response");
    expect(adapter.callCount).toBe(0);
  });
});

describe("license scope narrowing (§5.4: result not broader than input)", () => {
  it("takes the most restrictive audience, purpose intersection, earliest expiry", () => {
    const scope = narrowestLicenseScope([
      { audience: "public", purposes: ["ai_research", "ai_derivative"], validUntil: "2027-01-03T00:00:00.000Z" },
      { audience: "personal", purposes: ["ai_research"], validUntil: "2026-06-01T00:00:00.000Z" },
    ]);
    expect(scope).toEqual({ audience: "personal", purposes: ["ai_research"], validUntil: "2026-06-01T00:00:00.000Z" });
  });

  it("provenance: result carries consent + authorization epoch and both material references", async () => {
    const adapter = new RecordingGeminiAdapter(true);
    const { resolver, refs } = resolverFor(envelopeById("mat_full"), envelopeById("mat_personal_scope"));
    const svc = createResearchAssistant({ materialResolver: resolver, consentResolver: staticConsent(GRANTED), adapter, localRule: new RecordingLocalRule(), now: () => 1_700_000_000_000 });
    const out = await svc.run(summarize, refs, viewer);
    const v = value(out);
    expect(v?.materialReferences).toHaveLength(2);
    expect(v?.consentEpoch).toBe("consent:c1");
    expect(v?.authorizationEpoch).toBe("authz:e1");
    expect(v?.licenseScope.audience).toBe("personal");
  });
});

describe("containsForbiddenMaterial", () => {
  it("flags secret and direct-identifier markers", () => {
    expect(containsForbiddenMaterial("uses password hunter2")).toBe(true);
    expect(containsForbiddenMaterial("Bearer abc.def")).toBe(true);
    expect(containsForbiddenMaterial("account number 12345")).toBe(true);
    expect(containsForbiddenMaterial("AAA last trade 101.25")).toBe(false);
  });
});
