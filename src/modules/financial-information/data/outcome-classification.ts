import { brandReference } from "../../../shared/contracts/brands";
import type {
  ApiRequiredInformation,
  FailedInformation,
  InformationOutcome,
  LicenseRestrictedInformation,
  NoDataInformation,
  PolicyVersion,
  ProviderDegradation,
} from "@/shared";

import type { ProviderFailureKind } from "./contracts";

// Defined here (a leaf module) so freshness ↔ classification stay acyclic: a
// circular import let the top-level POLICY capture undefined before this module
// initialized, silently dropping policyVersion from every non-available outcome.
export const OBSERVATION_POLICY_VERSION: PolicyVersion =
  brandReference<string, "PolicyVersion">("policy:f4-freshness-v1");

const POLICY: PolicyVersion = OBSERVATION_POLICY_VERSION;

function degradation(
  code: ProviderDegradation["code"],
  provider: string,
  feed: string,
  occurredAt: string,
  extra: Partial<ProviderDegradation> = {},
): ProviderDegradation {
  return {
    code,
    provider,
    feed,
    occurredAt,
    retryable: extra.retryable ?? code !== "invalid_response",
    diagnosticReference: brandReference<string, "DiagnosticReference">(`diagnostic:f4-${code}:${feed}`),
    ...extra,
  };
}

export function invalidResponseOutcome(provider: string, feed: string, occurredAt: string): FailedInformation {
  return {
    status: "failed",
    degradation: degradation("invalid_response", provider, feed, occurredAt, { retryable: false }),
    policyVersion: POLICY,
  };
}

export function apiRequiredOutcome(requiredCapability: string, configurationRoute: string): ApiRequiredInformation {
  return { status: "unavailable", reason: "api_required", requiredCapability, configurationRoute, policyVersion: POLICY };
}

export function noDataOutcome(queryRange: string, asOf: string): NoDataInformation {
  return { status: "unavailable", reason: "no_data", queryRange, asOf, policyVersion: POLICY };
}

/**
 * Normalize a provider failure into an Information Outcome (§5.1 last paragraph):
 * - 401 → failed/reauthentication_required
 * - 403 entitlement/display denial → license_restricted (no value, no secret)
 * - 403 credential/account-authorization denial → failed/reauthentication_required
 * - 403 other → failed/forbidden_upstream
 * - 429/quota → failed/quota with typed retryAfter
 * - timeout → failed/timeout (retryable)
 * - 5xx → failed/upstream (retryable)
 * - malformed/future → invalid_response (terminal, quarantine)
 *
 * Raw provider error text and secrets never enter the outcome — only the typed
 * code and a diagnostic reference (SEC-05).
 */
export function classifyProviderFailure(input: Readonly<{
  failure: ProviderFailureKind;
  provider: string;
  feed: string;
  occurredAt: string;
  source?: string;
  purpose?: string;
}>): FailedInformation | LicenseRestrictedInformation {
  const { failure, provider, feed, occurredAt } = input;
  switch (failure.kind) {
    case "reauthentication_required":
      return {
        status: "failed",
        degradation: degradation("reauthentication_required", provider, feed, occurredAt, { retryable: false }),
        policyVersion: POLICY,
      };
    case "denied": {
      if (failure.denial === "entitlement") {
        return {
          status: "unavailable",
          reason: "license_restricted",
          source: input.source ?? provider,
          purpose: input.purpose ?? "display",
          policyVersion: POLICY,
        };
      }
      if (failure.denial === "credential") {
        return {
          status: "failed",
          degradation: degradation("reauthentication_required", provider, feed, occurredAt, { retryable: false }),
          policyVersion: POLICY,
        };
      }
      return {
        status: "failed",
        degradation: degradation("forbidden_upstream", provider, feed, occurredAt, { retryable: false }),
        policyVersion: POLICY,
      };
    }
    case "quota":
      return {
        status: "failed",
        degradation: degradation("quota", provider, feed, occurredAt, { retryable: true, retryAfter: failure.retryAfter }),
        policyVersion: POLICY,
      };
    case "timeout":
      return {
        status: "failed",
        degradation: degradation("timeout", provider, feed, occurredAt, { retryable: true }),
        policyVersion: POLICY,
      };
    case "upstream":
      return {
        status: "failed",
        degradation: degradation("upstream", provider, feed, occurredAt, { retryable: true }),
        policyVersion: POLICY,
      };
    case "invalid_response":
      return invalidResponseOutcome(provider, feed, occurredAt);
  }
}

/** True when a failure must NOT advance any cache/snapshot watermark (§5.1: malformed/future quarantine). */
export function isQuarantineFailure(outcome: InformationOutcome<unknown>): boolean {
  return outcome.status === "failed" && outcome.degradation.code === "invalid_response";
}
