import catalogJson from "../../../../fixtures/spec/f4/evidence-catalog.json";
import { brandReference } from "../../../shared/contracts/brands";
import type { AvailableInformation, PolicyVersion } from "@/shared";
import type { EvidenceReference } from "@/shared";
import type { ViewerContext } from "@/shared/contracts/viewer-context";
import { z } from "zod";

import type { EvidenceOutcome, EvidenceResolver, EvidenceValue } from "./evidence-contracts";
import { applyEvidenceFreshness } from "./evidence-normalization";
import { OBSERVATION_POLICY_VERSION } from "./observation-freshness";
import { classifyProviderFailure, noDataOutcome } from "./outcome-classification";

const residualPolicySchema = z.object({
  kind: z.literal("residual"),
  declaredDelayMs: z.number().nonnegative(),
  softResidualMs: z.number().positive(),
  hardResidualMs: z.number().positive(),
}).strict();

const cadencePolicySchema = z.object({
  kind: z.literal("cadence"),
  cadenceMs: z.number().positive(),
  softGraceMs: z.number().nonnegative(),
  hardMissedPublications: z.number().int().positive(),
}).strict();

const newsHeadlineSchema = z.object({
  title: z.string(), source: z.string(), publishedAt: z.string(), link: z.string(), snippet: z.string().optional(),
}).strict();

const filingEntrySchema = z.object({
  form: z.string(), source: z.string(), filedAt: z.string(), accession: z.string(), link: z.string(),
}).strict();

const evidenceValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("news"), headlines: z.array(newsHeadlineSchema) }).strict(),
  z.object({ kind: z.literal("filing"), filings: z.array(filingEntrySchema) }).strict(),
]);

const failureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reauthentication_required") }).strict(),
  z.object({ kind: z.literal("denied"), denial: z.enum(["entitlement", "credential", "other"]) }).strict(),
  z.object({ kind: z.literal("quota"), retryAfter: z.iso.datetime() }).strict(),
  z.object({ kind: z.literal("timeout") }).strict(),
  z.object({ kind: z.literal("upstream") }).strict(),
  z.object({ kind: z.literal("invalid_response") }).strict(),
]);

const scenarioSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("evidence"), feed: z.string().min(1), policy: z.union([residualPolicySchema, cadencePolicySchema]), value: evidenceValueSchema }).strict(),
  z.object({ type: z.literal("failure"), feed: z.string().min(1), failure: failureSchema, source: z.string().optional(), purpose: z.string().optional() }).strict(),
  z.object({ type: z.literal("no_data"), queryRange: z.string().min(1), asOf: z.iso.datetime() }).strict(),
]);

const caseSchema = z.object({
  id: z.string().min(1),
  reference: z.string().min(1),
  purpose: z.string().min(1),
  scenario: scenarioSchema,
}).strict();

const catalogSchema = z.object({
  marker: z.literal("SYNTHETIC TEST DATA"),
  provider: z.literal("synthetic"),
  isSynthetic: z.literal(true),
  now: z.iso.datetime(),
  licenseScope: z.object({
    audience: z.enum(["public", "personal", "internal_test_only"]),
    purposes: z.array(z.string().min(1)).min(1),
    validUntil: z.iso.datetime(),
  }).strict(),
  cases: z.array(caseSchema).min(1),
}).strict();

export type EvidenceCatalog = z.infer<typeof catalogSchema>;
type EvidenceCase = z.infer<typeof caseSchema>;

export function loadSyntheticEvidenceCatalog(): EvidenceCatalog {
  return catalogSchema.parse(catalogJson);
}

const fixturePolicyVersion: PolicyVersion = OBSERVATION_POLICY_VERSION;

function buildEvidenceOutcome(entry: EvidenceCase, licenseScope: EvidenceCatalog["licenseScope"], nowMs: number): EvidenceOutcome {
  const occurredAt = new Date(nowMs).toISOString();
  const { scenario } = entry;
  if (scenario.type === "no_data") return noDataOutcome(scenario.queryRange, scenario.asOf);
  if (scenario.type === "failure") {
    return classifyProviderFailure({
      failure: scenario.failure, provider: "synthetic", feed: scenario.feed, occurredAt,
      ...(scenario.source !== undefined ? { source: scenario.source } : {}),
      ...(scenario.purpose !== undefined ? { purpose: scenario.purpose } : {}),
    });
  }
  const reference = brandReference<string, "EvidenceReference">(entry.reference);
  // stamp each entry's evidence reference from the case reference so consumers keep provenance.
  const stamped: EvidenceValue = scenario.value.kind === "news"
    ? { kind: "news", headlines: scenario.value.headlines.map((h) => ({ ...h, evidenceReference: reference })) }
    : { kind: "filing", filings: scenario.value.filings.map((f) => ({ ...f, evidenceReference: reference })) };
  const asOf = stamped.kind === "news"
    ? stamped.headlines.map((h) => h.publishedAt).sort().at(-1)!
    : stamped.filings.map((f) => f.filedAt).sort().at(-1)!;
  const available: AvailableInformation<EvidenceValue> = {
    status: "available", value: stamped, evidenceReference: reference,
    provider: "synthetic", feed: scenario.feed, venue: "SYNTHETIC",
    asOf, receivedAt: occurredAt, freshness: "realtime", licenseScope, policyVersion: fixturePolicyVersion,
  };
  return applyEvidenceFreshness(available, { nowMs, policy: scenario.policy });
}

/**
 * Fixture-backed EvidenceResolver (§6.1 server-only seam). Resolves an opaque
 * source reference to a purpose-bound typed outcome — no raw Evidence getter.
 * Unknown reference or a purpose the source does not license → value-less outcome.
 */
export function createScriptedEvidenceResolver(
  catalog = loadSyntheticEvidenceCatalog(),
  nowMs = Date.parse(catalog.now),
): EvidenceResolver {
  const byReference = new Map<string, EvidenceCase>(catalog.cases.map((entry) => [entry.reference, entry]));
  return {
    resolve(reference: EvidenceReference, purpose: string, _viewer: ViewerContext): Promise<EvidenceOutcome> {
      const entry = byReference.get(reference);
      if (!entry) return Promise.resolve(noDataOutcome(reference, new Date(nowMs).toISOString()));
      // purpose binding: the source must license the requested purpose, else no value.
      if (!catalog.licenseScope.purposes.includes(purpose) || entry.purpose !== purpose) {
        return Promise.resolve({ status: "unavailable", reason: "license_restricted", source: entry.reference, purpose, policyVersion: fixturePolicyVersion });
      }
      return Promise.resolve(buildEvidenceOutcome(entry, catalog.licenseScope, nowMs));
    },
  };
}
