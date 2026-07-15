import { brandReference } from "../../../shared/contracts/brands";
import type { AvailableInformation } from "@/shared";

import type { EvidenceOutcome, EvidenceValue } from "./evidence-contracts";
import type { ObservationExpiryPolicy } from "./contracts";
import { classifyObservationFreshness, observationHardExpired } from "./observation-freshness";
import { invalidResponseOutcome } from "./outcome-classification";

function isCanonicalTimestamp(value: string, nowMs: number): boolean {
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== value) return false;
  return ms <= nowMs;
}

/** An evidence set is malformed if any entry is missing a required field or carries a non-canonical/future timestamp. */
export function isMalformedEvidence(value: EvidenceValue, nowMs: number): boolean {
  if (value.kind === "news") {
    if (value.headlines.length === 0) return true;
    return value.headlines.some(
      (h) => !h.title || !h.source || !h.link || !isCanonicalTimestamp(h.publishedAt, nowMs),
    );
  }
  if (value.filings.length === 0) return true;
  return value.filings.some(
    (f) => !f.form || !f.source || !f.accession || !f.link || !isCanonicalTimestamp(f.filedAt, nowMs),
  );
}

/** Latest as-of across the evidence set — the watermark used for freshness. */
function latestAsOfMs(value: EvidenceValue): number {
  const stamps = value.kind === "news"
    ? value.headlines.map((h) => Date.parse(h.publishedAt))
    : value.filings.map((f) => Date.parse(f.filedAt));
  return Math.max(...stamps);
}

/**
 * Apply freshness/expiry/invalid to an available evidence set, reusing the
 * shared classifiers. Malformed/future → invalid_response (quarantine);
 * hard-expired → no_data (no value); soft-expired → stale + retryable
 * degradation; fresh → passthrough.
 */
export function applyEvidenceFreshness(
  available: AvailableInformation<EvidenceValue>,
  input: Readonly<{ nowMs: number; policy: ObservationExpiryPolicy }>,
): EvidenceOutcome {
  const occurredAt = new Date(input.nowMs).toISOString();
  if (isMalformedEvidence(available.value, input.nowMs)) {
    return invalidResponseOutcome(available.provider, available.feed, occurredAt);
  }
  const classification = classifyObservationFreshness({ asOfMs: latestAsOfMs(available.value), nowMs: input.nowMs, policy: input.policy });
  if (classification.kind === "invalid") {
    return invalidResponseOutcome(available.provider, available.feed, occurredAt);
  }
  if (classification.kind === "hard_expired") {
    return observationHardExpired(available.value.kind, available.asOf);
  }
  if (classification.kind === "soft_expired") {
    const stale: AvailableInformation<EvidenceValue> = {
      ...available,
      freshness: "stale",
      degradation: {
        code: "timeout",
        provider: available.provider,
        feed: available.feed,
        occurredAt,
        retryable: true,
        diagnosticReference: brandReference<string, "DiagnosticReference">(`diagnostic:f4-soft-expiry:${available.feed}`),
      },
    };
    return stale;
  }
  const fresh: AvailableInformation<EvidenceValue> = { ...available, freshness: classification.freshness };
  return fresh;
}
