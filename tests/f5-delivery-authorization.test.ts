import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import {
  resolveAccountChallengeDelivery,
  resolveFinancialDelivery,
  resolveSecurityNoticeDelivery,
  type AccountChallengeRecord,
  type AccountChallengeState,
  type FinancialDeliveryRecord,
  type FinancialDeliveryState,
  type SecurityNoticeRecord,
  type SecurityNoticeState,
} from "../src/modules/notification-center/delivery-authorization";

const NOW = "2026-07-16T00:00:00.000Z";
const LATER = "2026-07-16T01:00:00.000Z";
const PAST = "2026-07-15T23:00:00.000Z";

const ref = <N extends string>(v: string) => brandReference<string, N>(v);

// --- Financial ----------------------------------------------------------------

function financial(): { record: FinancialDeliveryRecord; current: FinancialDeliveryState } {
  return {
    record: {
      deliveryReference: ref("fin:1"),
      workspaceReference: ref("workspace:w1"),
      channel: "email",
      target: ref("dest:1"),
      authorizationEpoch: ref("auth:5"),
      membershipRevision: ref("mem:3"),
      channelConsentEpoch: ref("consent:2"),
      endpointRevision: ref("addr:7"),
      authorizedEpoch: 10,
      expiresAt: LATER,
    },
    current: {
      authorizationEpoch: ref("auth:5"),
      membershipRevision: ref("mem:3"),
      accountActive: true,
      channelConsentEpoch: ref("consent:2"),
      endpointRevision: ref("addr:7"),
      deletionFence: 0,
      now: NOW,
    },
  };
}

describe("resolveFinancialDelivery (spec §12, SEC-06)", () => {
  it("resolves a purpose-tagged financial context when every value matches", () => {
    const { record, current } = financial();
    const out = resolveFinancialDelivery(record, current);
    expect(out).toEqual({
      status: "resolved",
      context: {
        kind: "financial",
        channel: "email",
        purpose: "financial_alert",
        workspaceReference: "workspace:w1",
        target: "dest:1",
        expiresAt: LATER,
      },
    });
  });

  it("rejects (value-less) when the account authorization epoch is stale", () => {
    const { record, current } = financial();
    const out = resolveFinancialDelivery(record, { ...current, authorizationEpoch: ref("auth:6") });
    expect(out).toEqual({ status: "rejected", reason: "stale_epoch" });
  });

  it("rejects when the workspace was erased (deletion fence raised to the authorized epoch)", () => {
    const { record, current } = financial();
    const out = resolveFinancialDelivery(record, { ...current, deletionFence: 10 });
    expect(out).toEqual({ status: "rejected", reason: "deletion_fenced" });
  });

  it("rejects when membership ended", () => {
    const { record, current } = financial();
    expect(resolveFinancialDelivery(record, { ...current, accountActive: false })).toEqual({ status: "rejected", reason: "membership_terminated" });
    expect(resolveFinancialDelivery(record, { ...current, membershipRevision: ref("mem:4") })).toEqual({ status: "rejected", reason: "membership_terminated" });
  });

  it("rejects when the channel opt-in was withdrawn", () => {
    const { record, current } = financial();
    const out = resolveFinancialDelivery(record, { ...current, channelConsentEpoch: ref("consent:3") });
    expect(out).toEqual({ status: "rejected", reason: "channel_consent_withdrawn" });
  });

  it("rejects when the verified-address revision changed", () => {
    const { record, current } = financial();
    const out = resolveFinancialDelivery(record, { ...current, endpointRevision: ref("addr:8") });
    expect(out).toEqual({ status: "rejected", reason: "address_revision_changed" });
  });

  it("rejects when the intent expired", () => {
    const { record, current } = financial();
    const out = resolveFinancialDelivery(record, { ...current, now: LATER });
    expect(out).toEqual({ status: "rejected", reason: "expired" });
    expect(resolveFinancialDelivery({ ...record, expiresAt: PAST }, current)).toEqual({ status: "rejected", reason: "expired" });
  });
});

// --- Account challenge: pending -----------------------------------------------

type PendingRecord = Extract<AccountChallengeRecord, { variant: "pending" }>;
type PendingState = Extract<AccountChallengeState, { variant: "pending" }>;
type WorkspaceRecord = Extract<AccountChallengeRecord, { variant: "workspace" }>;
type WorkspaceState = Extract<AccountChallengeState, { variant: "workspace" }>;

function pending(): { record: PendingRecord; current: PendingState } {
  return {
    record: {
      variant: "pending",
      eventReference: ref("event:1"),
      target: ref("dest:pending:1"),
      pendingIdentity: ref("pending:1"),
      purpose: "verify_email",
      requestSecurityEpoch: ref("req:4"),
      authorizedEpoch: 10,
      expiresAt: LATER,
    },
    current: { variant: "pending", requestSecurityEpoch: ref("req:4"), pendingIdentityValid: true, deletionFence: 0, now: NOW },
  };
}

describe("resolveAccountChallengeDelivery — pending variant (spec §12 line 339)", () => {
  it("resolves the pending challenge context when values match", () => {
    const { record, current } = pending();
    expect(resolveAccountChallengeDelivery(record, current)).toEqual({
      status: "resolved",
      context: { kind: "account_challenge_pending", purpose: "verify_email", target: "dest:pending:1", expiresAt: LATER },
    });
  });

  it("rejects a stale request-security epoch", () => {
    const { record, current } = pending();
    expect(resolveAccountChallengeDelivery(record, { ...current, requestSecurityEpoch: ref("req:5") })).toEqual({ status: "rejected", reason: "stale_epoch" });
  });

  it("rejects when the pending identity is no longer valid", () => {
    const { record, current } = pending();
    expect(resolveAccountChallengeDelivery(record, { ...current, pendingIdentityValid: false })).toEqual({ status: "rejected", reason: "pending_identity_invalid" });
  });

  it("rejects when fenced or expired", () => {
    const { record, current } = pending();
    expect(resolveAccountChallengeDelivery(record, { ...current, deletionFence: 10 })).toEqual({ status: "rejected", reason: "deletion_fenced" });
    expect(resolveAccountChallengeDelivery(record, { ...current, now: LATER })).toEqual({ status: "rejected", reason: "expired" });
  });

  it("rejects a non-pending purpose as cross_purpose", () => {
    const { record, current } = pending();
    expect(resolveAccountChallengeDelivery({ ...record, purpose: "sign_in" }, current)).toEqual({ status: "rejected", reason: "cross_purpose" });
  });

  it("rejects a pending record resolved against workspace state (variant swap)", () => {
    const { record } = pending();
    const wsState: AccountChallengeState = {
      variant: "workspace",
      authorizationEpoch: ref("auth:5"),
      membershipRevision: ref("mem:3"),
      accountActive: true,
      endpointRevision: ref("addr:7"),
      deletionFence: 0,
      now: NOW,
    };
    expect(resolveAccountChallengeDelivery(record, wsState)).toEqual({ status: "rejected", reason: "cross_purpose" });
  });
});

// --- Account challenge: workspace ---------------------------------------------

function workspace(): { record: WorkspaceRecord; current: WorkspaceState } {
  return {
    record: {
      variant: "workspace",
      eventReference: ref("event:2"),
      endpoint: ref("endpoint:1"),
      workspaceReference: ref("workspace:w1"),
      purpose: "sign_in",
      authorizationEpoch: ref("auth:5"),
      membershipRevision: ref("mem:3"),
      endpointRevision: ref("addr:7"),
      authorizedEpoch: 10,
      expiresAt: LATER,
    },
    current: {
      variant: "workspace",
      authorizationEpoch: ref("auth:5"),
      membershipRevision: ref("mem:3"),
      accountActive: true,
      endpointRevision: ref("addr:7"),
      deletionFence: 0,
      now: NOW,
    },
  };
}

describe("resolveAccountChallengeDelivery — workspace variant (spec §12 line 338)", () => {
  it("resolves the workspace challenge context when values match", () => {
    const { record, current } = workspace();
    expect(resolveAccountChallengeDelivery(record, current)).toEqual({
      status: "resolved",
      context: { kind: "account_challenge_workspace", purpose: "sign_in", workspaceReference: "workspace:w1", endpoint: "endpoint:1", expiresAt: LATER },
    });
  });

  it("rejects a stale account authorization epoch and a changed address revision", () => {
    const { record, current } = workspace();
    expect(resolveAccountChallengeDelivery(record, { ...current, authorizationEpoch: ref("auth:6") })).toEqual({ status: "rejected", reason: "stale_epoch" });
    expect(resolveAccountChallengeDelivery(record, { ...current, endpointRevision: ref("addr:8") })).toEqual({ status: "rejected", reason: "address_revision_changed" });
  });

  it("rejects terminated membership, fence and expiry", () => {
    const { record, current } = workspace();
    expect(resolveAccountChallengeDelivery(record, { ...current, accountActive: false })).toEqual({ status: "rejected", reason: "membership_terminated" });
    expect(resolveAccountChallengeDelivery(record, { ...current, deletionFence: 12 })).toEqual({ status: "rejected", reason: "deletion_fenced" });
    expect(resolveAccountChallengeDelivery(record, { ...current, now: LATER })).toEqual({ status: "rejected", reason: "expired" });
  });

  it("rejects the security-notice purpose on the challenge resolver as cross_purpose", () => {
    const { record, current } = workspace();
    expect(resolveAccountChallengeDelivery({ ...record, purpose: "authenticated_security_notice" }, current)).toEqual({ status: "rejected", reason: "cross_purpose" });
  });
});

// --- Security notice ----------------------------------------------------------

function notice(): { record: SecurityNoticeRecord; current: SecurityNoticeState } {
  return {
    record: {
      eventReference: ref("event:3"),
      endpoint: ref("endpoint:1"),
      workspaceReference: ref("workspace:w1"),
      purpose: "authenticated_security_notice",
      securityNoticeEpoch: ref("notice:2"),
      membershipRevision: ref("mem:3"),
      endpointRevision: ref("addr:7"),
      authorizedEpoch: 10,
      expiresAt: LATER,
    },
    current: {
      securityNoticeEpoch: ref("notice:2"),
      membershipRevision: ref("mem:3"),
      accountActive: true,
      endpointRevision: ref("addr:7"),
      deletionFence: 0,
      now: NOW,
    },
  };
}

describe("resolveSecurityNoticeDelivery (spec §12 line 338)", () => {
  it("resolves the security-notice context when values match", () => {
    const { record, current } = notice();
    expect(resolveSecurityNoticeDelivery(record, current)).toEqual({
      status: "resolved",
      context: { kind: "security_notice", purpose: "authenticated_security_notice", workspaceReference: "workspace:w1", endpoint: "endpoint:1", expiresAt: LATER },
    });
  });

  it("rejects a stale security-notice epoch (distinct from account authorization epoch)", () => {
    const { record, current } = notice();
    expect(resolveSecurityNoticeDelivery(record, { ...current, securityNoticeEpoch: ref("notice:3") })).toEqual({ status: "rejected", reason: "stale_epoch" });
  });

  it("rejects membership end, address change, fence and expiry", () => {
    const { record, current } = notice();
    expect(resolveSecurityNoticeDelivery(record, { ...current, accountActive: false })).toEqual({ status: "rejected", reason: "membership_terminated" });
    expect(resolveSecurityNoticeDelivery(record, { ...current, endpointRevision: ref("addr:8") })).toEqual({ status: "rejected", reason: "address_revision_changed" });
    expect(resolveSecurityNoticeDelivery(record, { ...current, deletionFence: 10 })).toEqual({ status: "rejected", reason: "deletion_fenced" });
    expect(resolveSecurityNoticeDelivery(record, { ...current, now: LATER })).toEqual({ status: "rejected", reason: "expired" });
  });

  it("rejects any challenge purpose on the notice resolver as cross_purpose", () => {
    const { record, current } = notice();
    for (const purpose of ["verify_email", "pending_recovery", "sign_in", "recovery"] as const) {
      expect(resolveSecurityNoticeDelivery({ ...record, purpose }, current)).toEqual({ status: "rejected", reason: "cross_purpose" });
    }
  });
});
