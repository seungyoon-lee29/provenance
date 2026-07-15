import type {
  AccountAuthorizationEpoch,
  Brand,
  DeliveryEndpointReference,
  DeliveryTargetReference,
  FinancialConsentEpoch,
  FinancialDeliveryReference,
  MembershipRevision,
  RequestSecurityEpoch,
  SecurityEventReference,
  WorkspaceReference,
} from "@/shared/contracts/brands";

import type { SecurityPurpose } from "./delivery-intent";

/**
 * F5 Delivery Authorization Context resolve (spec §12, lines 254/338/339, SEC-06).
 *
 * A durable delivery reference records the authorization values it was issued
 * under (owner + each purpose epoch/revision + the deletion epoch). `resolve*`
 * re-derives a purpose-tagged Delivery Authorization Context from that record
 * and Identity-owned CURRENT state — it never takes a transient Viewer Context.
 * Any stale epoch, changed revision, terminated membership, cross-purpose use,
 * expiry, or raised deletion fence yields a VALUE-LESS rejected outcome: no
 * target, endpoint or action material leaves the resolver. The dispatch loop
 * (B4) calls the same resolve again immediately before render/dispatch, so this
 * decision is idempotent and re-checked at the egress boundary.
 */

// Authorization components not present in the shared contract; module-local so
// a security-notice epoch can never stand in for an account authorization epoch.
export type VerifiedAddressRevision = Brand<string, "VerifiedAddressRevision">;
export type SecurityNoticeEpoch = Brand<string, "SecurityNoticeEpoch">;
export type PendingIdentityReference = Brand<string, "PendingIdentityReference">;

const PENDING_PURPOSES = new Set<SecurityPurpose>(["verify_email", "pending_recovery"]);
const WORKSPACE_CHALLENGE_PURPOSES = new Set<SecurityPurpose>(["sign_in", "recovery"]);

export type DeliveryAuthorizationRejection =
  | "cross_purpose"
  | "deletion_fenced"
  | "membership_terminated"
  | "stale_epoch"
  | "address_revision_changed"
  | "channel_consent_withdrawn"
  | "pending_identity_invalid"
  | "expired";

export type DeliveryAuthorizationContext =
  | Readonly<{
      kind: "financial";
      channel: "email" | "web_push";
      purpose: "financial_alert";
      workspaceReference: WorkspaceReference;
      target: DeliveryTargetReference;
      expiresAt: string;
    }>
  | Readonly<{
      kind: "account_challenge_pending";
      purpose: "verify_email" | "pending_recovery";
      target: DeliveryTargetReference;
      expiresAt: string;
    }>
  | Readonly<{
      kind: "account_challenge_workspace";
      purpose: "sign_in" | "recovery";
      workspaceReference: WorkspaceReference;
      endpoint: DeliveryEndpointReference;
      expiresAt: string;
    }>
  | Readonly<{
      kind: "security_notice";
      purpose: "authenticated_security_notice";
      workspaceReference: WorkspaceReference;
      endpoint: DeliveryEndpointReference;
      expiresAt: string;
    }>;

export type DeliveryAuthorizationOutcome =
  | Readonly<{ status: "resolved"; context: DeliveryAuthorizationContext }>
  | Readonly<{ status: "rejected"; reason: DeliveryAuthorizationRejection }>;

const resolved = (context: DeliveryAuthorizationContext): DeliveryAuthorizationOutcome => ({ status: "resolved", context });
const rejected = (reason: DeliveryAuthorizationRejection): DeliveryAuthorizationOutcome => ({ status: "rejected", reason });

/** A record authorized at `authorizedEpoch` is fenced once erasure raises the subject's deletion fence to it or beyond. */
function isFenced(authorizedEpoch: number, deletionFence: number): boolean {
  return authorizedEpoch <= deletionFence;
}

function isExpired(now: string, expiresAt: string): boolean {
  return now >= expiresAt;
}

// --- Financial (AlertOccurrence → financial_email | financial_web_push) --------

export type FinancialDeliveryRecord = Readonly<{
  deliveryReference: FinancialDeliveryReference;
  workspaceReference: WorkspaceReference;
  channel: "email" | "web_push";
  target: DeliveryTargetReference;
  authorizationEpoch: AccountAuthorizationEpoch;
  membershipRevision: MembershipRevision;
  channelConsentEpoch: FinancialConsentEpoch;
  endpointRevision: VerifiedAddressRevision;
  authorizedEpoch: number;
  expiresAt: string;
}>;

export type FinancialDeliveryState = Readonly<{
  authorizationEpoch: AccountAuthorizationEpoch;
  membershipRevision: MembershipRevision;
  accountActive: boolean;
  channelConsentEpoch: FinancialConsentEpoch;
  endpointRevision: VerifiedAddressRevision;
  deletionFence: number;
  now: string;
}>;

export function resolveFinancialDelivery(
  record: FinancialDeliveryRecord,
  current: FinancialDeliveryState,
): DeliveryAuthorizationOutcome {
  if (isFenced(record.authorizedEpoch, current.deletionFence)) return rejected("deletion_fenced");
  if (!current.accountActive || record.membershipRevision !== current.membershipRevision) return rejected("membership_terminated");
  if (record.authorizationEpoch !== current.authorizationEpoch) return rejected("stale_epoch");
  if (record.channelConsentEpoch !== current.channelConsentEpoch) return rejected("channel_consent_withdrawn");
  if (record.endpointRevision !== current.endpointRevision) return rejected("address_revision_changed");
  if (isExpired(current.now, record.expiresAt)) return rejected("expired");
  return resolved({
    kind: "financial",
    channel: record.channel,
    purpose: "financial_alert",
    workspaceReference: record.workspaceReference,
    target: record.target,
    expiresAt: record.expiresAt,
  });
}

// --- Account challenge (pending | workspace) ----------------------------------

export type AccountChallengeRecord =
  | Readonly<{
      variant: "pending";
      eventReference: SecurityEventReference;
      target: DeliveryTargetReference;
      pendingIdentity: PendingIdentityReference;
      purpose: SecurityPurpose;
      requestSecurityEpoch: RequestSecurityEpoch;
      authorizedEpoch: number;
      expiresAt: string;
    }>
  | Readonly<{
      variant: "workspace";
      eventReference: SecurityEventReference;
      endpoint: DeliveryEndpointReference;
      workspaceReference: WorkspaceReference;
      purpose: SecurityPurpose;
      authorizationEpoch: AccountAuthorizationEpoch;
      membershipRevision: MembershipRevision;
      endpointRevision: VerifiedAddressRevision;
      authorizedEpoch: number;
      expiresAt: string;
    }>;

export type AccountChallengeState =
  | Readonly<{
      variant: "pending";
      requestSecurityEpoch: RequestSecurityEpoch;
      pendingIdentityValid: boolean;
      deletionFence: number;
      now: string;
    }>
  | Readonly<{
      variant: "workspace";
      authorizationEpoch: AccountAuthorizationEpoch;
      membershipRevision: MembershipRevision;
      accountActive: boolean;
      endpointRevision: VerifiedAddressRevision;
      deletionFence: number;
      now: string;
    }>;

export function resolveAccountChallengeDelivery(
  record: AccountChallengeRecord,
  current: AccountChallengeState,
): DeliveryAuthorizationOutcome {
  // pending ↔ workspace variant may not be swapped (spec §12 line 339).
  if (record.variant !== current.variant) return rejected("cross_purpose");

  if (record.variant === "pending" && current.variant === "pending") {
    if (!PENDING_PURPOSES.has(record.purpose)) return rejected("cross_purpose");
    if (isFenced(record.authorizedEpoch, current.deletionFence)) return rejected("deletion_fenced");
    if (!current.pendingIdentityValid) return rejected("pending_identity_invalid");
    if (record.requestSecurityEpoch !== current.requestSecurityEpoch) return rejected("stale_epoch");
    if (isExpired(current.now, record.expiresAt)) return rejected("expired");
    return resolved({
      kind: "account_challenge_pending",
      purpose: record.purpose as "verify_email" | "pending_recovery",
      target: record.target,
      expiresAt: record.expiresAt,
    });
  }

  if (record.variant === "workspace" && current.variant === "workspace") {
    if (!WORKSPACE_CHALLENGE_PURPOSES.has(record.purpose)) return rejected("cross_purpose");
    if (isFenced(record.authorizedEpoch, current.deletionFence)) return rejected("deletion_fenced");
    if (!current.accountActive || record.membershipRevision !== current.membershipRevision) return rejected("membership_terminated");
    if (record.authorizationEpoch !== current.authorizationEpoch) return rejected("stale_epoch");
    if (record.endpointRevision !== current.endpointRevision) return rejected("address_revision_changed");
    if (isExpired(current.now, record.expiresAt)) return rejected("expired");
    return resolved({
      kind: "account_challenge_workspace",
      purpose: record.purpose as "sign_in" | "recovery",
      workspaceReference: record.workspaceReference,
      endpoint: record.endpoint,
      expiresAt: record.expiresAt,
    });
  }

  return rejected("cross_purpose");
}

// --- Security notice (authenticated_security_notice) --------------------------

export type SecurityNoticeRecord = Readonly<{
  eventReference: SecurityEventReference;
  endpoint: DeliveryEndpointReference;
  workspaceReference: WorkspaceReference;
  purpose: SecurityPurpose;
  securityNoticeEpoch: SecurityNoticeEpoch;
  membershipRevision: MembershipRevision;
  endpointRevision: VerifiedAddressRevision;
  authorizedEpoch: number;
  expiresAt: string;
}>;

export type SecurityNoticeState = Readonly<{
  securityNoticeEpoch: SecurityNoticeEpoch;
  membershipRevision: MembershipRevision;
  accountActive: boolean;
  endpointRevision: VerifiedAddressRevision;
  deletionFence: number;
  now: string;
}>;

export function resolveSecurityNoticeDelivery(
  record: SecurityNoticeRecord,
  current: SecurityNoticeState,
): DeliveryAuthorizationOutcome {
  // The security-notice context can never carry a challenge purpose (spec §12 line 338).
  if (record.purpose !== "authenticated_security_notice") return rejected("cross_purpose");
  if (isFenced(record.authorizedEpoch, current.deletionFence)) return rejected("deletion_fenced");
  if (!current.accountActive || record.membershipRevision !== current.membershipRevision) return rejected("membership_terminated");
  if (record.securityNoticeEpoch !== current.securityNoticeEpoch) return rejected("stale_epoch");
  if (record.endpointRevision !== current.endpointRevision) return rejected("address_revision_changed");
  if (isExpired(current.now, record.expiresAt)) return rejected("expired");
  return resolved({
    kind: "security_notice",
    purpose: "authenticated_security_notice",
    workspaceReference: record.workspaceReference,
    endpoint: record.endpoint,
    expiresAt: record.expiresAt,
  });
}
