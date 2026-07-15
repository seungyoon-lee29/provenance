/**
 * Blind, decorrelated acceptance test for the ResearchAssistant AI path (AT-04).
 *
 * Expectations are derived from SPEC §5.4 + AT-04 and the PUBLIC interface only
 * (contracts.ts, scripted-research.ts exports, information-outcome.ts). The
 * `run` decision logic in research-service.ts was NOT read — this test is an
 * independent source of truth so it can disagree with the implementation.
 */
import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { LicenseScope, PolicyVersion } from "../src/shared";
import type { GuestViewerContext, WorkspaceViewerContext } from "../src/shared/contracts/viewer-context";

import type {
  AiAdapterResult,
  AiMaterialOutcome,
  LocalRuleEngine,
  ResearchTaskShape,
} from "../src/modules/research-assistant/contracts";
import {
  RecordingGeminiAdapter,
  RecordingLocalRule,
  MutableConsent,
  consentEpoch,
  envelopeById,
  scriptedMaterialResolver,
  staticConsent,
} from "../src/modules/research-assistant/scripted-research";
import { createResearchAssistant, type ResearchDeps } from "../src/modules/research-assistant/research-service";

// ---- fixtures / builders (spec-side, not code-side) --------------------------

const workspaceViewer: WorkspaceViewerContext = {
  kind: "workspace",
  requestId: "req-1",
  workspaceReference: "x" as never,
  accountReference: "x" as never,
  sessionReference: "x" as never,
  sessionGeneration: "x" as never,
  accountAuthorizationEpoch: "x" as never,
  membershipRevision: "x" as never,
};
const guestViewer: GuestViewerContext = { kind: "guest", requestId: "req-guest" };

const grantedConsent = {
  granted: true,
  allowsExternalProcessing: true,
  epoch: consentEpoch("c1"),
} as const;

function task(mode: "summarize" | "derive"): ResearchTaskShape {
  return { kind: "ResearchTask", instruction: "summarize the material", mode } as ResearchTaskShape;
}

/** A LocalRuleEngine that supports NOTHING — models "no local fallback for this task". */
const neverLocal: LocalRuleEngine & { callCount: number } = {
  rulePolicyVersion: brandReference<string, "PolicyVersion">("policy:f4-never-local"),
  callCount: 0,
  supports: () => false,
  run(t, envelopes) {
    this.callCount++;
    return `NEVER ${envelopes.length} ${t.mode}`;
  },
};

/** Map a set of catalog envelopes into a resolver that returns them as `available`. */
function resolverFor(...ids: string[]) {
  const entries = new Map<string, AiMaterialOutcome>();
  const refs = ids.map((id) => {
    const env = envelopeById(id);
    entries.set(env.reference, { status: "available", value: env });
    return env.reference;
  });
  return { resolver: scriptedMaterialResolver(entries), refs };
}

function deps(over: Partial<ResearchDeps>): ResearchDeps {
  const base = resolverFor("mat_full");
  return {
    materialResolver: base.resolver,
    consentResolver: staticConsent(grantedConsent),
    adapter: new RecordingGeminiAdapter(true),
    localRule: new RecordingLocalRule(),
    now: () => 0,
    ...over,
  };
}

// ---- 1. happy external path --------------------------------------------------

describe("AT-04 happy path", () => {
  it("mat_full with consent+key → available, produced by gemini, exactly 1 gemini call", async () => {
    const { resolver, refs } = resolverFor("mat_full");
    const adapter = new RecordingGeminiAdapter(true);
    const localRule = new RecordingLocalRule();
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule }));

    const out = await svc.run(task("summarize"), [...refs], workspaceViewer);

    expect(out.status).toBe("available");
    if (out.status !== "available") throw new Error("unreachable");
    const value = out.value as unknown as { producedBy: string };
    expect(value.producedBy).toBe("gemini");
    expect(adapter.callCount).toBe(1);
  });
});

// ---- 2. derivative-creation forbidden ---------------------------------------

describe("AT-04 derivative forbidden", () => {
  it("derive on mat_no_derivative → license_restricted, 0 gemini + 0 local", async () => {
    const { resolver, refs } = resolverFor("mat_no_derivative");
    const adapter = new RecordingGeminiAdapter(true);
    const localRule = new RecordingLocalRule(true); // even a derive-capable local must not run
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule }));

    const out = await svc.run(task("derive"), [...refs], workspaceViewer);

    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") throw new Error("unreachable");
    expect(out.reason).toBe("license_restricted");
    expect(adapter.callCount).toBe(0);
    expect(localRule.callCount).toBe(0);
  });
});

// ---- 3 & 4. external-processing forbidden -----------------------------------

describe("AT-04 external forbidden", () => {
  it("mat_no_external summarize → local rule fallback, 0 gemini", async () => {
    const { resolver, refs } = resolverFor("mat_no_external");
    const adapter = new RecordingGeminiAdapter(true);
    const localRule = new RecordingLocalRule();
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule }));

    const out = await svc.run(task("summarize"), [...refs], workspaceViewer);

    expect(out.status).toBe("available");
    if (out.status !== "available") throw new Error("unreachable");
    expect((out.value as unknown as { producedBy: string }).producedBy).toBe("local_rule");
    expect(adapter.callCount).toBe(0);
    expect(localRule.callCount).toBe(1);
  });

  it("mat_no_external + local supports nothing → license_restricted, 0 calls", async () => {
    const { resolver, refs } = resolverFor("mat_no_external");
    const adapter = new RecordingGeminiAdapter(true);
    neverLocal.callCount = 0;
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule: neverLocal }));

    const out = await svc.run(task("summarize"), [...refs], workspaceViewer);

    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") throw new Error("unreachable");
    expect(out.reason).toBe("license_restricted");
    expect(adapter.callCount).toBe(0);
    expect(neverLocal.callCount).toBe(0);
  });
});

// ---- 5. key absent -----------------------------------------------------------

describe("AT-04 key absent", () => {
  it("no key + local supports → local rule, 0 gemini", async () => {
    const { resolver, refs } = resolverFor("mat_full");
    const adapter = new RecordingGeminiAdapter(false);
    const localRule = new RecordingLocalRule();
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule }));

    const out = await svc.run(task("summarize"), [...refs], workspaceViewer);

    expect(out.status).toBe("available");
    if (out.status !== "available") throw new Error("unreachable");
    expect((out.value as unknown as { producedBy: string }).producedBy).toBe("local_rule");
    expect(adapter.callCount).toBe(0);
    expect(localRule.callCount).toBe(1);
  });

  it("no key + no local → api_required, 0 gemini", async () => {
    const { resolver, refs } = resolverFor("mat_full");
    const adapter = new RecordingGeminiAdapter(false);
    neverLocal.callCount = 0;
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule: neverLocal }));

    const out = await svc.run(task("summarize"), [...refs], workspaceViewer);

    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") throw new Error("unreachable");
    expect(out.reason).toBe("api_required");
    expect(adapter.callCount).toBe(0);
  });
});

// ---- 6. gemini degraded (quota) ---------------------------------------------

const quotaResult: AiAdapterResult = { kind: "degraded", code: "quota" };

describe("AT-04 provider degradation", () => {
  it("gemini quota + local supports → local rule + quota degradation", async () => {
    const { resolver, refs } = resolverFor("mat_full");
    const adapter = new RecordingGeminiAdapter(true, quotaResult);
    const localRule = new RecordingLocalRule();
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule }));

    const out = await svc.run(task("summarize"), [...refs], workspaceViewer);

    expect(out.status).toBe("available");
    if (out.status !== "available") throw new Error("unreachable");
    const value = out.value as unknown as { producedBy: string; degradation?: { code: string } };
    expect(value.producedBy).toBe("local_rule");
    expect(value.degradation?.code).toBe("quota");
    expect(adapter.callCount).toBe(1); // it DID try gemini, then degraded
    expect(localRule.callCount).toBe(1);
  });

  it("gemini quota + no local → failed with degradation", async () => {
    const { resolver, refs } = resolverFor("mat_full");
    const adapter = new RecordingGeminiAdapter(true, quotaResult);
    neverLocal.callCount = 0;
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule: neverLocal }));

    const out = await svc.run(task("summarize"), [...refs], workspaceViewer);

    expect(out.status).toBe("failed");
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.degradation.code).toBe("quota");
  });
});

// ---- 7. consent / guest / empty ---------------------------------------------

describe("AT-04 consent + evidence gates", () => {
  it("no consent → value-less, 0 gemini + 0 local", async () => {
    const { resolver, refs } = resolverFor("mat_full");
    const adapter = new RecordingGeminiAdapter(true);
    const localRule = new RecordingLocalRule();
    const noConsent = staticConsent({ granted: false, allowsExternalProcessing: false, epoch: consentEpoch("c1") });
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule, consentResolver: noConsent }));

    const out = await svc.run(task("summarize"), [...refs], workspaceViewer);

    expect(out.status).not.toBe("available");
    expect(adapter.callCount).toBe(0);
    expect(localRule.callCount).toBe(0);
  });

  it("guest viewer → value-less, 0 gemini + 0 local", async () => {
    const { resolver, refs } = resolverFor("mat_full");
    const adapter = new RecordingGeminiAdapter(true);
    const localRule = new RecordingLocalRule();
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule }));

    const out = await svc.run(task("summarize"), [...refs], guestViewer);

    expect(out.status).not.toBe("available");
    expect(adapter.callCount).toBe(0);
    expect(localRule.callCount).toBe(0);
  });

  it("empty references → no_data", async () => {
    const adapter = new RecordingGeminiAdapter(true);
    const localRule = new RecordingLocalRule();
    const svc = createResearchAssistant(deps({ materialResolver: scriptedMaterialResolver(new Map()), adapter, localRule }));

    const out = await svc.run(task("summarize"), [], workspaceViewer);

    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") throw new Error("unreachable");
    expect(out.reason).toBe("no_data");
    expect(adapter.callCount).toBe(0);
  });
});

// ---- 8. source-denied material ----------------------------------------------

describe("AT-04 source-denied", () => {
  it("resolver maps ref to license_restricted → license_restricted, 0 calls", async () => {
    const ref = envelopeById("mat_full").reference;
    const denied: AiMaterialOutcome = {
      status: "unavailable",
      reason: "license_restricted",
      source: "source",
      purpose: "ai_research",
      policyVersion: brandReference<string, "PolicyVersion">("policy:src"),
    };
    const resolver = scriptedMaterialResolver(new Map([[ref, denied]]));
    const adapter = new RecordingGeminiAdapter(true);
    const localRule = new RecordingLocalRule();
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule }));

    const out = await svc.run(task("summarize"), [ref], workspaceViewer);

    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") throw new Error("unreachable");
    expect(out.reason).toBe("license_restricted");
    expect(adapter.callCount).toBe(0);
    expect(localRule.callCount).toBe(0);
  });
});

// ---- 9. SEC-06 pre-dispatch consent recheck ---------------------------------

describe("AT-04 SEC-06 pre-dispatch recheck", () => {
  it("consent epoch bumps between run-start read and dispatch → value-less, 0 gemini", async () => {
    const { resolver, refs } = resolverFor("mat_full");
    const adapter = new RecordingGeminiAdapter(true);
    const localRule = new RecordingLocalRule();
    // MutableConsent returns granted first, then a bumped epoch on the pre-dispatch recheck.
    let reads = 0;
    const consent = new MutableConsent(grantedConsent);
    const spying = {
      resolve() {
        reads++;
        if (reads > 1) consent.set({ granted: true, allowsExternalProcessing: true, epoch: consentEpoch("c2") });
        return consent.resolve();
      },
    };
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule, consentResolver: spying }));

    const out = await svc.run(task("summarize"), [...refs], workspaceViewer);

    expect(out.status).not.toBe("available");
    expect(adapter.callCount).toBe(0);
  });
});

// ---- 10. redaction backstop --------------------------------------------------

describe("AT-04 redaction", () => {
  it("mat_leaky secrets never reach the model, outcome value-less/failed, 0 gemini", async () => {
    const { resolver, refs } = resolverFor("mat_leaky");
    const adapter = new RecordingGeminiAdapter(true);
    const localRule = new RecordingLocalRule();
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule }));

    const out = await svc.run(task("summarize"), [...refs], workspaceViewer);

    for (const prompt of adapter.prompts) {
      expect(prompt.toLowerCase()).not.toContain("password");
      expect(prompt.toLowerCase()).not.toContain("account number");
      expect(prompt).not.toContain("hunter2");
    }
    expect(out.status).not.toBe("available");
    expect(adapter.callCount).toBe(0);
  });
});

// ---- 11. license narrowing ---------------------------------------------------

describe("AT-04 license narrowing", () => {
  it("mat_full (public) + mat_personal_scope (personal, earlier expiry) → most-restrictive scope", async () => {
    const { resolver, refs } = resolverFor("mat_full", "mat_personal_scope");
    const adapter = new RecordingGeminiAdapter(true);
    const localRule = new RecordingLocalRule();
    const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule }));

    const out = await svc.run(task("summarize"), [...refs], workspaceViewer);

    expect(out.status).toBe("available");
    if (out.status !== "available") throw new Error("unreachable");
    const scope = (out.value as unknown as { licenseScope: LicenseScope }).licenseScope;
    // most-restrictive audience of {public, personal} = personal
    expect(scope.audience).toBe("personal");
    // earliest validUntil of the two inputs
    expect(scope.validUntil).toBe("2026-06-01T00:00:00.000Z");
    // purpose intersection of [ai_research, ai_derivative] ∩ [ai_research] = [ai_research]
    expect([...scope.purposes].sort()).toEqual(["ai_research"]);
  });
});

// ---- 12. aggregate egress invariant -----------------------------------------

describe("AT-04 aggregate egress invariant", () => {
  it("across every forbidden/denied case: total gemini callCount 0, no secret in any prompt", async () => {
    const secretMarker = /password|account\s*number|hunter2|sk-|bearer\s/i;
    const cases: Array<() => Promise<RecordingGeminiAdapter>> = [
      // derivative forbidden
      async () => {
        const { resolver, refs } = resolverFor("mat_no_derivative");
        const adapter = new RecordingGeminiAdapter(true);
        const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, localRule: new RecordingLocalRule(true) }));
        await svc.run(task("derive"), [...refs], workspaceViewer);
        return adapter;
      },
      // no consent
      async () => {
        const { resolver, refs } = resolverFor("mat_full");
        const adapter = new RecordingGeminiAdapter(true);
        const consent = staticConsent({ granted: false, allowsExternalProcessing: false, epoch: consentEpoch("c1") });
        const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter, consentResolver: consent }));
        await svc.run(task("summarize"), [...refs], workspaceViewer);
        return adapter;
      },
      // guest
      async () => {
        const { resolver, refs } = resolverFor("mat_full");
        const adapter = new RecordingGeminiAdapter(true);
        const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter }));
        await svc.run(task("summarize"), [...refs], guestViewer);
        return adapter;
      },
      // source-denied
      async () => {
        const ref = envelopeById("mat_full").reference;
        const resolver = scriptedMaterialResolver(new Map([[ref, {
          status: "unavailable", reason: "license_restricted", source: "s", purpose: "ai_research",
          policyVersion: brandReference<string, "PolicyVersion">("policy:src"),
        } satisfies AiMaterialOutcome]]));
        const adapter = new RecordingGeminiAdapter(true);
        const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter }));
        await svc.run(task("summarize"), [ref], workspaceViewer);
        return adapter;
      },
      // leaky material
      async () => {
        const { resolver, refs } = resolverFor("mat_leaky");
        const adapter = new RecordingGeminiAdapter(true);
        const svc = createResearchAssistant(deps({ materialResolver: resolver, adapter }));
        await svc.run(task("summarize"), [...refs], workspaceViewer);
        return adapter;
      },
    ];

    let totalCalls = 0;
    for (const run of cases) {
      const adapter = await run();
      totalCalls += adapter.callCount;
      for (const prompt of adapter.prompts) expect(prompt).not.toMatch(secretMarker);
    }
    expect(totalCalls).toBe(0);
  });
});
