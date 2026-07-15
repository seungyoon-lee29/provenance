import catalogJson from "../../../fixtures/spec/f4/ai-material-catalog.json";
import { brandReference } from "../../shared/contracts/brands";
import type {
  AiConsentEpoch,
  AiMaterialReference,
  PolicyVersion,
} from "@/shared";
import type { ViewerContext } from "@/shared/contracts/viewer-context";
import { z } from "zod";

import type {
  AiConsent,
  AiConsentResolver,
  AiMaterialEnvelope,
  AiMaterialOutcome,
  AiMaterialResolver,
  AiModelAdapter,
  AiAdapterResult,
  LocalRuleEngine,
  ResearchTaskShape,
} from "./contracts";

const envelopeSchema = z.object({
  id: z.string().min(1),
  reference: z.string().min(1),
  category: z.enum(["market", "news", "filing", "chart", "portfolio", "order"]),
  summary: z.string().min(1),
  evidenceReferences: z.array(z.string().min(1)),
  rights: z.object({
    retention: z.enum(["none", "session", "durable"]),
    externalProcessing: z.boolean(),
    derivative: z.boolean(),
  }).strict(),
  licenseScope: z.object({
    audience: z.enum(["public", "personal", "internal_test_only"]),
    purposes: z.array(z.string().min(1)).min(1),
    validUntil: z.iso.datetime(),
  }).strict(),
}).strict();

const catalogSchema = z.object({
  marker: z.literal("SYNTHETIC TEST DATA"),
  provider: z.literal("synthetic"),
  isSynthetic: z.literal(true),
  redactionPolicyVersion: z.string().min(1),
  envelopes: z.array(envelopeSchema).min(1),
}).strict();

export type AiMaterialCatalog = z.infer<typeof catalogSchema>;

export function loadAiMaterialCatalog(): AiMaterialCatalog {
  return catalogSchema.parse(catalogJson);
}

/** Build a typed envelope from a catalog id (branding the opaque references). */
export function envelopeById(id: string, catalog = loadAiMaterialCatalog()): AiMaterialEnvelope {
  const found = catalog.envelopes.find((e) => e.id === id);
  if (!found) throw new Error(`unknown fixture envelope: ${id}`);
  return {
    reference: brandReference<string, "AiMaterialReference">(found.reference),
    category: found.category,
    summary: found.summary,
    evidenceReferences: found.evidenceReferences.map((r) => brandReference<string, "EvidenceReference">(r)),
    rights: found.rights,
    licenseScope: found.licenseScope,
    redactionPolicyVersion: brandReference<string, "PolicyVersion">(catalog.redactionPolicyVersion),
  };
}

/**
 * Source-owned resolver over a fixed set of envelopes. A reference mapped to a
 * value-less outcome (e.g. license_restricted) models the source denying the
 * purpose; an unmapped reference resolves to no_data.
 */
export function scriptedMaterialResolver(
  entries: ReadonlyMap<string, AiMaterialOutcome>,
): AiMaterialResolver {
  return {
    resolve(reference: AiMaterialReference): Promise<AiMaterialOutcome> {
      const found = entries.get(reference);
      if (found) return Promise.resolve(found);
      return Promise.resolve({ status: "unavailable", reason: "no_data", queryRange: reference, asOf: new Date(0).toISOString(), policyVersion: brandReference<string, "PolicyVersion">("policy:f4-research-v1") });
    },
  };
}

/** Records every prompt so tests can assert egress-0 for forbidden categories. */
export class RecordingGeminiAdapter implements AiModelAdapter {
  readonly prompts: string[] = [];
  readonly modelPolicyVersion: PolicyVersion = brandReference<string, "PolicyVersion">("policy:f4-gemini-v1");
  constructor(
    readonly available: boolean,
    private readonly result: AiAdapterResult = { kind: "ok", generation: { text: "SCRIPTED GEMINI SUMMARY", modelPolicyVersion: brandReference<string, "PolicyVersion">("policy:f4-gemini-v1") } },
  ) {}
  generate(prompt: string, _viewer: ViewerContext): Promise<AiAdapterResult> {
    this.prompts.push(prompt);
    return Promise.resolve(this.result);
  }
  get callCount(): number { return this.prompts.length; }
}

/** Records every invocation; supports summarize by default, derive optionally. */
export class RecordingLocalRule implements LocalRuleEngine {
  readonly calls: ResearchTaskShape[] = [];
  readonly rulePolicyVersion: PolicyVersion = brandReference<string, "PolicyVersion">("policy:f4-local-rule-v1");
  constructor(private readonly supportsDerive = false) {}
  supports(task: ResearchTaskShape): boolean {
    return task.mode === "summarize" || this.supportsDerive;
  }
  run(task: ResearchTaskShape, envelopes: readonly AiMaterialEnvelope[]): string {
    this.calls.push(task);
    return `LOCAL RULE: ${envelopes.length} material(s) for ${task.mode}`;
  }
  get callCount(): number { return this.calls.length; }
}

export function staticConsent(consent: AiConsent): AiConsentResolver {
  return { resolve: () => consent };
}

/** Consent that can be withdrawn/bumped mid-run to exercise the SEC-06 pre-dispatch recheck. */
export class MutableConsent implements AiConsentResolver {
  constructor(private current: AiConsent | undefined) {}
  resolve(): AiConsent | undefined { return this.current; }
  set(next: AiConsent | undefined): void { this.current = next; }
}

export function consentEpoch(value: string): AiConsentEpoch {
  return brandReference<string, "AiConsentEpoch">(value);
}
