import type {
  AccountAuthorizationEpoch,
  AiConsentEpoch,
  AiMaterialReference,
  EvidenceReference,
  FailedInformation,
  LicenseScope,
  PolicyVersion,
  ProviderDegradation,
  ResearchResult,
  ResearchTask,
  UnavailableInformation,
} from "@/shared";
import type { ViewerContext } from "@/shared/contracts/viewer-context";

/**
 * ResearchAssistant (F4, §5.4). AI runs on source-owned AI Material References
 * only — never client-built raw payloads. A source-owned resolver rechecks
 * viewer/ownership/consent/rights and hands back a MINIMIZED, REDACTED envelope
 * (no secrets, no direct identifiers) that is safe to place in a model prompt.
 * The same category policy applies to every material type.
 */

export type AiMaterialCategory = "market" | "news" | "filing" | "chart" | "portfolio" | "order";

/** Rights carried from the source's License Scope; each gate is checked independently (§5.4). */
export type AiMaterialRights = Readonly<{
  retention: "none" | "session" | "durable";
  /** may be sent to an external model (e.g. Gemini). */
  externalProcessing: boolean;
  /** may be used to create derivative works. */
  derivative: boolean;
}>;

/**
 * Minimized material safe for a prompt. `summary` is already redacted by the
 * owning source — it must never contain Provider Credentials, session/auth
 * tokens, raw account numbers, order-execution secrets or direct identifiers.
 */
export type AiMaterialEnvelope = Readonly<{
  reference: AiMaterialReference;
  category: AiMaterialCategory;
  summary: string;
  evidenceReferences: readonly EvidenceReference[];
  rights: AiMaterialRights;
  licenseScope: LicenseScope;
  redactionPolicyVersion: PolicyVersion;
}>;

export type ResearchTaskShape = ResearchTask & Readonly<{
  instruction: string;
  /** `derive` requests a derivative work; `summarize` does not. */
  mode: "summarize" | "derive";
}>;

export type ResearchResultShape = ResearchResult & Readonly<{
  answer: string;
  producedBy: "gemini" | "local_rule";
  materialReferences: readonly AiMaterialReference[];
  evidenceReferences: readonly EvidenceReference[];
  consentEpoch: AiConsentEpoch;
  authorizationEpoch: AccountAuthorizationEpoch;
  modelPolicyVersion: PolicyVersion;
  redactionPolicyVersion: PolicyVersion;
  licenseScope: LicenseScope;
  degradation?: ProviderDegradation;
  generatedAt: string;
}>;

/** Either the typed envelope, or a value-less Information Outcome (§6.1) — no raw provenance ceremony. */
export type AiMaterialOutcome =
  | Readonly<{ status: "available"; value: AiMaterialEnvelope }>
  | UnavailableInformation
  | FailedInformation;

/** Source-owned resolver (§6.1). Returns purpose-bound typed material or a value-less outcome. */
export interface AiMaterialResolver {
  resolve(
    reference: AiMaterialReference,
    purpose: string,
    viewer: ViewerContext,
  ): Promise<AiMaterialOutcome>;
}

export type AiConsent = Readonly<{
  granted: boolean;
  allowsExternalProcessing: boolean;
  epoch: AiConsentEpoch;
}>;

/** Rechecked at run start AND immediately before dispatch (SEC-06). */
export interface AiConsentResolver {
  resolve(viewer: ViewerContext): AiConsent | undefined;
}

export type AiGeneration = Readonly<{ text: string; modelPolicyVersion: PolicyVersion }>;

export type AiAdapterResult =
  | Readonly<{ kind: "ok"; generation: AiGeneration }>
  | Readonly<{ kind: "degraded"; code: ProviderDegradation["code"]; retryAfter?: string }>;

/**
 * External model seam. `available` is false when no API key is configured
 * (`free_only` / contract-only). `generate` receives only redacted envelope
 * text — the service asserts the prompt carries no secret before calling.
 */
export interface AiModelAdapter {
  readonly available: boolean;
  readonly modelPolicyVersion: PolicyVersion;
  generate(prompt: string, viewer: ViewerContext): Promise<AiAdapterResult>;
}

/** On-device fallback: no external egress. Supports a subset of tasks. */
export interface LocalRuleEngine {
  readonly rulePolicyVersion: PolicyVersion;
  supports(task: ResearchTaskShape): boolean;
  run(task: ResearchTaskShape, envelopes: readonly AiMaterialEnvelope[]): string;
}
