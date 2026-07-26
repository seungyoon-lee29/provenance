declare const brand: unique symbol;

export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type WorkspaceReference = Brand<string, "WorkspaceReference">;
export type AccountReference = Brand<string, "AccountReference">;
export type SessionReference = Brand<string, "SessionReference">;
export type ProviderConnectionReference = Brand<string, "ProviderConnectionReference">;
export type EvidenceReference = Brand<string, "EvidenceReference">;
export type JobContextReference = Brand<string, "JobContextReference">;
export type JobAuthorizationVersion = Brand<string, "JobAuthorizationVersion">;
export type DiagnosticReference = Brand<string, "DiagnosticReference">;
export type SourceReference = Brand<string, "SourceReference">;
export type FinancialDeliveryReference = Brand<string, "FinancialDeliveryReference">;
export type SecurityEventReference = Brand<string, "SecurityEventReference">;
export type DeliveryTargetReference = Brand<string, "DeliveryTargetReference">;
export type DeliveryEndpointReference = Brand<string, "DeliveryEndpointReference">;
export type AdministrativeErasureReference = Brand<string, "AdministrativeErasureReference">;
export type ActualPortfolioReference = Brand<string, "ActualPortfolioReference">;
export type PaperPortfolioReference = Brand<string, "PaperPortfolioReference">;
export type InternalPaperAccountReference = Brand<string, "InternalPaperAccountReference">;
export type BrokerPaperAccountReference = Brand<string, "BrokerPaperAccountReference">;
export type PaperOrderReference = Brand<string, "PaperOrderReference">;
export type Revision = Brand<string, "Revision">;
export type SessionGeneration = Brand<string, "SessionGeneration">;
export type AccountAuthorizationEpoch = Brand<string, "AccountAuthorizationEpoch">;
export type MembershipRevision = Brand<string, "MembershipRevision">;
export type RequestSecurityEpoch = Brand<string, "RequestSecurityEpoch">;
export type AiConsentEpoch = Brand<string, "AiConsentEpoch">;
export type FinancialConsentEpoch = Brand<string, "FinancialConsentEpoch">;
export type CredentialGeneration = Brand<string, "CredentialGeneration">;
export type CredentialVersion = Brand<string, "CredentialVersion">;
export type ConnectionLifecycleFence = Brand<string, "ConnectionLifecycleFence">;
export type PolicyVersion = Brand<string, "PolicyVersion">;
export type SchemaVersion = Brand<string, "SchemaVersion">;
export type VaultKeyVersion = Brand<string, "VaultKeyVersion">;

export function brandReference<Value extends string, Name extends string>(value: Value): Brand<Value, Name> {
  if (value.trim().length === 0) throw new Error("reference must not be empty");
  return value as Brand<Value, Name>;
}
