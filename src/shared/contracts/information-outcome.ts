import type { DiagnosticReference, EvidenceReference, PolicyVersion } from "./brands";

export type DataFreshness = "realtime" | "delayed" | "stale";

export type LicenseScope = Readonly<{
  audience: "public" | "personal" | "internal_test_only";
  purposes: readonly string[];
  validUntil: string;
}>;

export type ProviderDegradation = Readonly<{
  code: "quota" | "timeout" | "upstream" | "reauthentication_required" | "forbidden_upstream" | "invalid_response";
  provider: string;
  feed?: string;
  occurredAt: string;
  retryable: boolean;
  retryAfter?: string;
  diagnosticReference: DiagnosticReference;
}>;

export type AvailableInformation<T> = Readonly<{
  status: "available";
  value: T;
  evidenceReference: EvidenceReference;
  provider: string;
  feed: string;
  venue?: string;
  asOf: string;
  receivedAt: string;
  freshness: DataFreshness;
  licenseScope: LicenseScope;
  policyVersion: PolicyVersion;
  degradation?: ProviderDegradation;
}>;

export type ApiRequiredInformation = Readonly<{
  status: "unavailable";
  reason: "api_required";
  requiredCapability: string;
  configurationRoute: string;
  policyVersion: PolicyVersion;
  value?: never;
}>;

export type LicenseRestrictedInformation = Readonly<{
  status: "unavailable";
  reason: "license_restricted";
  source: string;
  purpose: string;
  policyVersion: PolicyVersion;
  value?: never;
}>;

export type NoDataInformation = Readonly<{
  status: "unavailable";
  reason: "no_data";
  queryRange: string;
  asOf: string;
  policyVersion: PolicyVersion;
  value?: never;
}>;

export type UnavailableInformation = ApiRequiredInformation | LicenseRestrictedInformation | NoDataInformation;

export type FailedInformation = Readonly<{
  status: "failed";
  degradation: ProviderDegradation;
  policyVersion: PolicyVersion;
  value?: never;
}>;

export type InformationOutcome<T> = AvailableInformation<T> | UnavailableInformation | FailedInformation;
