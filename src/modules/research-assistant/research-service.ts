import { brandReference } from "../../shared/contracts/brands";
import type {
  AiMaterialReference,
  ApiRequiredInformation,
  AvailableInformation,
  EvidenceReference,
  FailedInformation,
  InformationOutcome,
  LicenseRestrictedInformation,
  LicenseScope,
  NoDataInformation,
  PolicyVersion,
  ProviderDegradation,
  ResearchAssistant,
  ResearchResult,
  ResearchTask,
} from "@/shared";
import type { ViewerContext, WorkspaceViewerContext } from "@/shared/contracts/viewer-context";

import type {
  AiConsentResolver,
  AiMaterialEnvelope,
  AiMaterialResolver,
  AiModelAdapter,
  LocalRuleEngine,
  ResearchResultShape,
  ResearchTaskShape,
} from "./contracts";

const RESEARCH_POLICY: PolicyVersion = brandReference<string, "PolicyVersion">("policy:f4-research-v1");

export type ResearchDeps = Readonly<{
  materialResolver: AiMaterialResolver;
  consentResolver: AiConsentResolver;
  adapter: AiModelAdapter;
  localRule: LocalRuleEngine;
  now: () => number;
}>;

function apiRequired(requiredCapability: string): ApiRequiredInformation {
  return { status: "unavailable", reason: "api_required", requiredCapability, configurationRoute: "/settings/ai", policyVersion: RESEARCH_POLICY };
}
function licenseRestricted(source: string, purpose: string): LicenseRestrictedInformation {
  return { status: "unavailable", reason: "license_restricted", source, purpose, policyVersion: RESEARCH_POLICY };
}
function noData(): NoDataInformation {
  return { status: "unavailable", reason: "no_data", queryRange: "research", asOf: new Date(0).toISOString(), policyVersion: RESEARCH_POLICY };
}
function failed(degradation: ProviderDegradation): FailedInformation {
  return { status: "failed", degradation, policyVersion: RESEARCH_POLICY };
}

/**
 * Redaction backstop (SEC-05): envelopes are already source-redacted, but the
 * service refuses to place anything that looks like a secret or direct
 * identifier into a prompt. Fail closed — never egress on a match.
 */
const SECRET_MARKERS = [/sk-[a-z0-9]/i, /bearer\s/i, /password/i, /secret/i, /-----begin/i, /\bssn\b/i, /account\s*number/i];
export function containsForbiddenMaterial(text: string): boolean {
  return SECRET_MARKERS.some((re) => re.test(text));
}

const AUDIENCE_RANK: Record<LicenseScope["audience"], number> = { internal_test_only: 0, personal: 1, public: 2 };

/** Result License Scope is never broader than any input (§5.4): most-restrictive audience, purpose intersection, earliest expiry. */
export function narrowestLicenseScope(scopes: readonly LicenseScope[]): LicenseScope {
  const audience = scopes.reduce<LicenseScope["audience"]>(
    (acc, s) => (AUDIENCE_RANK[s.audience] < AUDIENCE_RANK[acc] ? s.audience : acc),
    "public",
  );
  const purposes = scopes.reduce<readonly string[]>(
    (acc, s) => acc.filter((p) => s.purposes.includes(p)),
    scopes[0]?.purposes ?? [],
  );
  const validUntil = scopes.reduce((acc, s) => (s.validUntil < acc ? s.validUntil : acc), scopes[0]?.validUntil ?? new Date(0).toISOString());
  return { audience, purposes, validUntil };
}

function isWorkspace(viewer: ViewerContext): viewer is WorkspaceViewerContext {
  return viewer.kind === "workspace";
}

function buildPrompt(task: ResearchTaskShape, envelopes: readonly AiMaterialEnvelope[]): string {
  const materials = envelopes.map((e) => `- [${e.category}] ${e.summary}`).join("\n");
  return `${task.instruction}\n\n${materials}`;
}

export function createResearchAssistant(deps: ResearchDeps): ResearchAssistant {
  const { materialResolver, consentResolver, adapter, localRule, now } = deps;

  async function run(
    rawTask: ResearchTask,
    materialReferences: AiMaterialReference[],
    viewer: ViewerContext,
  ): Promise<InformationOutcome<ResearchResult>> {
    const task = rawTask as ResearchTaskShape;
    // AI is personal: a guest has no account to bind consent to.
    if (!isWorkspace(viewer)) return apiRequired("ai_processing_consent");
    if (materialReferences.length === 0) return noData();

    const consent = consentResolver.resolve(viewer);
    if (!consent || !consent.granted) return apiRequired("ai_processing_consent");

    const purpose = task.mode === "derive" ? "ai_derivative" : "ai_research";
    const envelopes: AiMaterialEnvelope[] = [];
    let sawFailed = false;
    for (const reference of materialReferences) {
      const outcome = await materialResolver.resolve(reference, purpose, viewer);
      if (outcome.status === "available") envelopes.push(outcome.value);
      else if (outcome.status === "unavailable" && outcome.reason === "license_restricted") {
        return licenseRestricted(outcome.source, purpose); // source rights deny — 0 model calls
      } else if (outcome.status === "failed") sawFailed = true;
    }
    if (envelopes.length === 0) {
      return sawFailed
        ? failed({ code: "upstream", provider: "research", feed: "material", occurredAt: new Date(now()).toISOString(), retryable: true, diagnosticReference: brandReference<string, "DiagnosticReference">("diagnostic:f4-research-material") })
        : noData();
    }

    // Category policy (§5.4). Each gate independent.
    if (task.mode === "derive" && envelopes.some((e) => !e.rights.derivative)) {
      return licenseRestricted("ai-material", "ai_derivative"); // derivative forbidden — 0 model + 0 local calls
    }
    const externalAllowed = consent.allowsExternalProcessing && envelopes.every((e) => e.rights.externalProcessing);
    const evidenceReferences = dedupeEvidence(envelopes);
    const licenseScope = narrowestLicenseScope(envelopes.map((e) => e.licenseScope));
    const redactionPolicyVersion = envelopes[0]!.redactionPolicyVersion;

    const finish = (
      answer: string,
      producedBy: ResearchResultShape["producedBy"],
      modelPolicyVersion: PolicyVersion,
      degradation?: ProviderDegradation,
    ): AvailableInformation<ResearchResult> => {
      const generatedAt = new Date(now()).toISOString();
      const value: ResearchResultShape = {
        kind: "ResearchResult",
        answer,
        producedBy,
        materialReferences,
        evidenceReferences,
        consentEpoch: consent.epoch,
        authorizationEpoch: viewer.accountAuthorizationEpoch,
        modelPolicyVersion,
        redactionPolicyVersion,
        licenseScope,
        ...(degradation ? { degradation } : {}),
        generatedAt,
      };
      return {
        status: "available", value, evidenceReference: evidenceReferences[0] ?? brandReference<string, "EvidenceReference">("evidence:f4:research"),
        provider: producedBy === "gemini" ? "gemini" : "local", feed: "research", asOf: generatedAt, receivedAt: generatedAt,
        freshness: "realtime", licenseScope, policyVersion: modelPolicyVersion,
      };
    };

    const runLocalOr = (denied: () => InformationOutcome<ResearchResult>, degradation?: ProviderDegradation): InformationOutcome<ResearchResult> => {
      if (!localRule.supports(task)) return degradation ? failed(degradation) : denied();
      return finish(localRule.run(task, envelopes), "local_rule", localRule.rulePolicyVersion, degradation);
    };

    // External-processing-only forbidden → local rule or license_restricted.
    if (!externalAllowed) return runLocalOr(() => licenseRestricted("ai-material", "external_processing"));
    // Key absent → local rule or api_required.
    if (!adapter.available) return runLocalOr(() => apiRequired("ai_model"));

    const prompt = buildPrompt(task, envelopes);
    if (containsForbiddenMaterial(prompt)) {
      return failed({ code: "invalid_response", provider: "research", feed: "redaction", occurredAt: new Date(now()).toISOString(), retryable: false, diagnosticReference: brandReference<string, "DiagnosticReference">("diagnostic:f4-redaction-guard") });
    }
    // SEC-06: recheck consent immediately before egress; a mid-flight withdrawal/epoch bump blocks dispatch.
    const consentNow = consentResolver.resolve(viewer);
    if (!consentNow || !consentNow.granted || consentNow.epoch !== consent.epoch) return apiRequired("ai_processing_consent");

    const generated = await adapter.generate(prompt, viewer);
    if (generated.kind === "ok") return finish(generated.generation.text, "gemini", generated.generation.modelPolicyVersion);
    // quota/timeout/5xx → local rule + degradation, else failed.
    const degradation: ProviderDegradation = {
      code: generated.code, provider: "gemini", feed: "research", occurredAt: new Date(now()).toISOString(),
      retryable: generated.code !== "invalid_response",
      ...(generated.retryAfter ? { retryAfter: generated.retryAfter } : {}),
      diagnosticReference: brandReference<string, "DiagnosticReference">(`diagnostic:f4-research-${generated.code}`),
    };
    return runLocalOr(() => failed(degradation), degradation);
  }

  return { run };
}

function dedupeEvidence(envelopes: readonly AiMaterialEnvelope[]): readonly EvidenceReference[] {
  const seen = new Set<string>();
  const out: EvidenceReference[] = [];
  for (const e of envelopes) for (const ref of e.evidenceReferences) {
    if (!seen.has(ref)) { seen.add(ref); out.push(ref); }
  }
  return out;
}
