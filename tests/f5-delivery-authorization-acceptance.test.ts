/**
 * Blind acceptance (refutation) tests for delivery-authorization.
 *
 * Source of truth: spec §12, SEC-06.
 * These tests derive expected values from the SPEC and the INTERFACE CONTRACT
 * only. The implementation file was NOT read.
 *
 * Gate goal: confirm that resolved contexts match the spec, that every
 * rejection is value-less (no target/endpoint leak), and that boundary
 * semantics hold exactly.
 */

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

// ---------------------------------------------------------------------------
// Time sentinels
// "expired" when now >= expiresAt (ISO string compare, spec)
// ---------------------------------------------------------------------------
const T0 = "2026-01-15T12:00:00.000Z"; // "now" in most tests
const T1 = "2026-01-15T13:00:00.000Z"; // 1 h later: used as expiresAt (future)
const T_EXACT = "2026-01-15T12:00:00.000Z"; // same as T0 — triggers expiry (now === expiresAt)
const T_PAST = "2026-01-15T11:00:00.000Z"; // expiresAt already passed

// ---------------------------------------------------------------------------
// Narrowed discriminated-union helpers (avoids excess-property TS errors)
// ---------------------------------------------------------------------------
type PendingRecord = Extract<AccountChallengeRecord, { variant: "pending" }>;
type PendingState = Extract<AccountChallengeState, { variant: "pending" }>;
type WorkspaceRecord = Extract<AccountChallengeRecord, { variant: "workspace" }>;
type WorkspaceState = Extract<AccountChallengeState, { variant: "workspace" }>;

// ---------------------------------------------------------------------------
// Shorthand branded-reference builder
// ---------------------------------------------------------------------------
const r = <N extends string>(v: string) => brandReference<string, N>(v);

// ---------------------------------------------------------------------------
// Fixture factories — one canonical "all-green" fixture per context kind
// ---------------------------------------------------------------------------

function mkFinancial(overrideRecord?: Partial<FinancialDeliveryRecord>, overrideState?: Partial<FinancialDeliveryState>): { record: FinancialDeliveryRecord; state: FinancialDeliveryState } {
  const record: FinancialDeliveryRecord = {
    deliveryReference: r("fin-ref-1"),
    workspaceReference: r("ws-ref-1"),
    channel: "email",
    target: r("target-1"),
    authorizationEpoch: r("auth-epoch-1"),
    membershipRevision: r("mem-rev-1"),
    channelConsentEpoch: r("consent-epoch-1"),
    endpointRevision: r("addr-rev-1"),
    authorizedEpoch: 42,
    expiresAt: T1,
    ...overrideRecord,
  };
  const state: FinancialDeliveryState = {
    authorizationEpoch: r("auth-epoch-1"),
    membershipRevision: r("mem-rev-1"),
    accountActive: true,
    channelConsentEpoch: r("consent-epoch-1"),
    endpointRevision: r("addr-rev-1"),
    deletionFence: 0,
    now: T0,
    ...overrideState,
  };
  return { record, state };
}

function mkPending(overrideRecord?: Partial<PendingRecord>, overrideState?: Partial<PendingState>): { record: PendingRecord; state: PendingState } {
  const record: PendingRecord = {
    variant: "pending",
    eventReference: r("evt-ref-1"),
    target: r("pending-target-1"),
    pendingIdentity: r("pending-id-1"),
    purpose: "verify_email",
    requestSecurityEpoch: r("req-epoch-1"),
    authorizedEpoch: 7,
    expiresAt: T1,
    ...overrideRecord,
  };
  const state: PendingState = {
    variant: "pending",
    requestSecurityEpoch: r("req-epoch-1"),
    pendingIdentityValid: true,
    deletionFence: 0,
    now: T0,
    ...overrideState,
  };
  return { record, state };
}

function mkWorkspace(overrideRecord?: Partial<WorkspaceRecord>, overrideState?: Partial<WorkspaceState>): { record: WorkspaceRecord; state: WorkspaceState } {
  const record: WorkspaceRecord = {
    variant: "workspace",
    eventReference: r("evt-ref-2"),
    endpoint: r("endpoint-1"),
    workspaceReference: r("ws-ref-1"),
    purpose: "sign_in",
    authorizationEpoch: r("auth-epoch-1"),
    membershipRevision: r("mem-rev-1"),
    endpointRevision: r("addr-rev-1"),
    authorizedEpoch: 7,
    expiresAt: T1,
    ...overrideRecord,
  };
  const state: WorkspaceState = {
    variant: "workspace",
    authorizationEpoch: r("auth-epoch-1"),
    membershipRevision: r("mem-rev-1"),
    accountActive: true,
    endpointRevision: r("addr-rev-1"),
    deletionFence: 0,
    now: T0,
    ...overrideState,
  };
  return { record, state };
}

function mkNotice(overrideRecord?: Partial<SecurityNoticeRecord>, overrideState?: Partial<SecurityNoticeState>): { record: SecurityNoticeRecord; state: SecurityNoticeState } {
  const record: SecurityNoticeRecord = {
    eventReference: r("evt-ref-3"),
    endpoint: r("endpoint-2"),
    workspaceReference: r("ws-ref-2"),
    purpose: "authenticated_security_notice",
    securityNoticeEpoch: r("sn-epoch-1"),
    membershipRevision: r("mem-rev-2"),
    endpointRevision: r("addr-rev-2"),
    authorizedEpoch: 99,
    expiresAt: T1,
    ...overrideRecord,
  };
  const state: SecurityNoticeState = {
    securityNoticeEpoch: r("sn-epoch-1"),
    membershipRevision: r("mem-rev-2"),
    accountActive: true,
    endpointRevision: r("addr-rev-2"),
    deletionFence: 0,
    now: T0,
    ...overrideState,
  };
  return { record, state };
}

// ---------------------------------------------------------------------------
// Helper: assert outcome carries NO target/endpoint (value-less rejection)
// ---------------------------------------------------------------------------
function assertValueLess(outcome: unknown): void {
  expect(outcome).toEqual({ status: "rejected", reason: expect.any(String) });
  // No "context" field at all
  expect(outcome).not.toHaveProperty("context");
  // No "target" or "endpoint" leaking at the top level
  expect(outcome).not.toHaveProperty("target");
  expect(outcome).not.toHaveProperty("endpoint");
}

// ===========================================================================
// FINANCIAL DELIVERY
// ===========================================================================

describe("resolveFinancialDelivery — acceptance gate (spec §12, SEC-06)", () => {
  // --- Happy paths -----------------------------------------------------------

  it("resolves email financial context with exact spec shape and no extra fields", () => {
    const { record, state } = mkFinancial();
    const out = resolveFinancialDelivery(record, state);
    // Spec: context must have kind/channel/purpose/workspaceReference/target/expiresAt
    expect(out).toEqual({
      status: "resolved",
      context: {
        kind: "financial",
        channel: "email",
        purpose: "financial_alert",
        workspaceReference: "ws-ref-1",
        target: "target-1",
        expiresAt: T1,
      },
    });
    // No extra fields beyond context
    expect(out).not.toHaveProperty("reason");
  });

  it("resolves web_push channel variant with channel preserved in context", () => {
    const { record, state } = mkFinancial({ channel: "web_push" });
    const out = resolveFinancialDelivery(record, state);
    expect(out).toEqual({
      status: "resolved",
      context: {
        kind: "financial",
        channel: "web_push",
        purpose: "financial_alert",
        workspaceReference: "ws-ref-1",
        target: "target-1",
        expiresAt: T1,
      },
    });
  });

  // --- Deletion fence boundary -----------------------------------------------
  // Spec: authorizedEpoch <= deletionFence → rejected "deletion_fenced"

  it("rejects (value-less) when deletion fence equals authorizedEpoch (boundary)", () => {
    const { record, state } = mkFinancial({ authorizedEpoch: 42 }, { deletionFence: 42 });
    const out = resolveFinancialDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "deletion_fenced" });
    assertValueLess(out);
  });

  it("rejects (value-less) when deletion fence exceeds authorizedEpoch", () => {
    const { record, state } = mkFinancial({ authorizedEpoch: 42 }, { deletionFence: 100 });
    const out = resolveFinancialDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "deletion_fenced" });
    assertValueLess(out);
  });

  it("resolves when deletion fence is below authorizedEpoch (not yet fenced)", () => {
    const { record, state } = mkFinancial({ authorizedEpoch: 42 }, { deletionFence: 41 });
    const out = resolveFinancialDelivery(record, state);
    expect(out.status).toBe("resolved");
  });

  // --- Expiry boundary -------------------------------------------------------
  // Spec: rejected "expired" when now >= expiresAt

  it("rejects when now equals expiresAt (boundary — spec: now >= expiresAt)", () => {
    const { record, state } = mkFinancial({ expiresAt: T_EXACT }, { now: T_EXACT });
    const out = resolveFinancialDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "expired" });
    assertValueLess(out);
  });

  it("rejects when expiresAt is in the past", () => {
    const { record, state } = mkFinancial({ expiresAt: T_PAST });
    const out = resolveFinancialDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "expired" });
    assertValueLess(out);
  });

  it("resolves when expiresAt is strictly in the future", () => {
    const { record, state } = mkFinancial({ expiresAt: T1 }, { now: T0 });
    expect(resolveFinancialDelivery(record, state).status).toBe("resolved");
  });

  // --- Individual staleness failures (one wrong thing at a time) -------------

  it("rejects stale account authorization epoch (value-less)", () => {
    const { record, state } = mkFinancial({}, { authorizationEpoch: r("auth-epoch-CHANGED") });
    const out = resolveFinancialDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "stale_epoch" });
    assertValueLess(out);
  });

  it("rejects changed membership revision (value-less)", () => {
    const { record, state } = mkFinancial({}, { membershipRevision: r("mem-rev-CHANGED") });
    const out = resolveFinancialDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "membership_terminated" });
    assertValueLess(out);
  });

  it("rejects inactive account (value-less)", () => {
    const { record, state } = mkFinancial({}, { accountActive: false });
    const out = resolveFinancialDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "membership_terminated" });
    assertValueLess(out);
  });

  it("rejects withdrawn channel consent — financial channel opt-in is required (value-less)", () => {
    // Spec: financial delivery depends on financial consent; challenge/notice do NOT.
    const { record, state } = mkFinancial({}, { channelConsentEpoch: r("consent-epoch-WITHDRAWN") });
    const out = resolveFinancialDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "channel_consent_withdrawn" });
    assertValueLess(out);
  });

  it("rejects changed verified-address revision (value-less)", () => {
    const { record, state } = mkFinancial({}, { endpointRevision: r("addr-rev-CHANGED") });
    const out = resolveFinancialDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "address_revision_changed" });
    assertValueLess(out);
  });

  // --- Multiple failures (assert only status, not constrained reason) --------

  it("rejects when epoch, consent, and fence are all wrong (any reason, still value-less)", () => {
    const { record, state } = mkFinancial(
      { authorizedEpoch: 5 },
      { authorizationEpoch: r("auth-epoch-OTHER"), channelConsentEpoch: r("consent-OTHER"), deletionFence: 99 }
    );
    const out = resolveFinancialDelivery(record, state);
    expect(out.status).toBe("rejected");
    assertValueLess(out);
  });
});

// ===========================================================================
// ACCOUNT CHALLENGE — PENDING VARIANT
// ===========================================================================

describe("resolveAccountChallengeDelivery (pending) — acceptance gate (spec §12 line 339)", () => {
  // --- Happy paths -----------------------------------------------------------

  it("resolves pending verify_email context with correct spec shape", () => {
    const { record, state } = mkPending();
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({
      status: "resolved",
      context: {
        kind: "account_challenge_pending",
        purpose: "verify_email",
        target: "pending-target-1",
        expiresAt: T1,
      },
    });
    // No workspaceReference, endpoint in the pending context (spec: pending variant)
    expect(out).not.toHaveProperty("reason");
    if (out.status === "resolved") {
      expect(out.context).not.toHaveProperty("workspaceReference");
      expect(out.context).not.toHaveProperty("endpoint");
    }
  });

  it("resolves pending_recovery purpose correctly", () => {
    const { record, state } = mkPending({ purpose: "pending_recovery" });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({
      status: "resolved",
      context: {
        kind: "account_challenge_pending",
        purpose: "pending_recovery",
        target: "pending-target-1",
        expiresAt: T1,
      },
    });
  });

  // --- Deletion fence --------------------------------------------------------

  it("rejects value-less when deletion fence equals authorizedEpoch (boundary)", () => {
    const { record, state } = mkPending({ authorizedEpoch: 7 }, { deletionFence: 7 });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "deletion_fenced" });
    assertValueLess(out);
  });

  it("resolves when fence is strictly below authorizedEpoch", () => {
    const { record, state } = mkPending({ authorizedEpoch: 7 }, { deletionFence: 6 });
    expect(resolveAccountChallengeDelivery(record, state).status).toBe("resolved");
  });

  // --- Expiry boundary -------------------------------------------------------

  it("rejects when now === expiresAt (boundary)", () => {
    const { record, state } = mkPending({ expiresAt: T_EXACT }, { now: T_EXACT });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "expired" });
    assertValueLess(out);
  });

  // --- Individual failures ---------------------------------------------------

  it("rejects stale request-security epoch (value-less)", () => {
    const { record, state } = mkPending({}, { requestSecurityEpoch: r("req-epoch-CHANGED") });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "stale_epoch" });
    assertValueLess(out);
  });

  it("rejects invalid pending identity (value-less)", () => {
    const { record, state } = mkPending({}, { pendingIdentityValid: false });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "pending_identity_invalid" });
    assertValueLess(out);
  });

  // --- Cross-purpose ---------------------------------------------------------
  // Spec: pending/workspace swap → cross_purpose (no renderer/provider call)
  // Spec: authenticated_security_notice on challenge resolver → cross_purpose
  // Spec: workspace purposes (sign_in, recovery) on pending record → cross_purpose

  it("rejects pending record with workspace purpose sign_in as cross_purpose", () => {
    const { record, state } = mkPending({ purpose: "sign_in" });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "cross_purpose" });
    assertValueLess(out);
  });

  it("rejects pending record with workspace purpose recovery as cross_purpose", () => {
    const { record, state } = mkPending({ purpose: "recovery" });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "cross_purpose" });
    assertValueLess(out);
  });

  it("rejects pending record with security-notice purpose as cross_purpose", () => {
    const { record, state } = mkPending({ purpose: "authenticated_security_notice" });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "cross_purpose" });
    assertValueLess(out);
  });

  it("rejects pending record resolved against workspace current-state (variant swap = cross_purpose)", () => {
    const { record } = mkPending();
    // Spec line 339: pending/workspace variant exchange → renderer/provider calls = 0 → rejected
    const wsState: WorkspaceState = {
      variant: "workspace",
      authorizationEpoch: r("auth-epoch-1"),
      membershipRevision: r("mem-rev-1"),
      accountActive: true,
      endpointRevision: r("addr-rev-1"),
      deletionFence: 0,
      now: T0,
    };
    const out = resolveAccountChallengeDelivery(record, wsState);
    expect(out).toEqual({ status: "rejected", reason: "cross_purpose" });
    assertValueLess(out);
  });

  // --- Multiple failures -----------------------------------------------------

  it("rejects when epoch is stale AND identity invalid (any reason, value-less)", () => {
    const { record, state } = mkPending(
      {},
      { requestSecurityEpoch: r("req-epoch-OTHER"), pendingIdentityValid: false }
    );
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out.status).toBe("rejected");
    assertValueLess(out);
  });
});

// ===========================================================================
// ACCOUNT CHALLENGE — WORKSPACE VARIANT
// ===========================================================================

describe("resolveAccountChallengeDelivery (workspace) — acceptance gate (spec §12 line 338)", () => {
  // --- Happy paths -----------------------------------------------------------

  it("resolves workspace sign_in context with spec shape (no target field in resolved context)", () => {
    const { record, state } = mkWorkspace();
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({
      status: "resolved",
      context: {
        kind: "account_challenge_workspace",
        purpose: "sign_in",
        workspaceReference: "ws-ref-1",
        endpoint: "endpoint-1",
        expiresAt: T1,
      },
    });
    // Workspace variant context must not expose 'target' (pending field)
    if (out.status === "resolved") {
      expect(out.context).not.toHaveProperty("target");
    }
  });

  it("resolves workspace recovery purpose", () => {
    const { record, state } = mkWorkspace({ purpose: "recovery" });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({
      status: "resolved",
      context: {
        kind: "account_challenge_workspace",
        purpose: "recovery",
        workspaceReference: "ws-ref-1",
        endpoint: "endpoint-1",
        expiresAt: T1,
      },
    });
  });

  // --- Deletion fence --------------------------------------------------------

  it("rejects when deletion fence equals authorizedEpoch (boundary)", () => {
    const { record, state } = mkWorkspace({ authorizedEpoch: 7 }, { deletionFence: 7 });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "deletion_fenced" });
    assertValueLess(out);
  });

  // --- Expiry boundary -------------------------------------------------------

  it("rejects when now === expiresAt (boundary)", () => {
    const { record, state } = mkWorkspace({ expiresAt: T_EXACT }, { now: T_EXACT });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "expired" });
    assertValueLess(out);
  });

  // --- Individual failures ---------------------------------------------------

  it("rejects stale account authorization epoch (value-less)", () => {
    const { record, state } = mkWorkspace({}, { authorizationEpoch: r("auth-epoch-CHANGED") });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "stale_epoch" });
    assertValueLess(out);
  });

  it("rejects changed membership revision (value-less)", () => {
    const { record, state } = mkWorkspace({}, { membershipRevision: r("mem-rev-CHANGED") });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "membership_terminated" });
    assertValueLess(out);
  });

  it("rejects terminated account (accountActive false, value-less)", () => {
    const { record, state } = mkWorkspace({}, { accountActive: false });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "membership_terminated" });
    assertValueLess(out);
  });

  it("rejects changed verified-address revision (value-less)", () => {
    const { record, state } = mkWorkspace({}, { endpointRevision: r("addr-rev-CHANGED") });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "address_revision_changed" });
    assertValueLess(out);
  });

  // --- Cross-purpose ---------------------------------------------------------

  it("rejects workspace record with pending purpose verify_email as cross_purpose", () => {
    const { record, state } = mkWorkspace({ purpose: "verify_email" });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "cross_purpose" });
    assertValueLess(out);
  });

  it("rejects workspace record with pending purpose pending_recovery as cross_purpose", () => {
    const { record, state } = mkWorkspace({ purpose: "pending_recovery" });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "cross_purpose" });
    assertValueLess(out);
  });

  it("rejects workspace record with security-notice purpose as cross_purpose", () => {
    const { record, state } = mkWorkspace({ purpose: "authenticated_security_notice" });
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "cross_purpose" });
    assertValueLess(out);
  });

  it("rejects workspace record resolved against pending current-state (variant swap = cross_purpose)", () => {
    const { record } = mkWorkspace();
    const pendState: PendingState = {
      variant: "pending",
      requestSecurityEpoch: r("req-epoch-1"),
      pendingIdentityValid: true,
      deletionFence: 0,
      now: T0,
    };
    const out = resolveAccountChallengeDelivery(record, pendState);
    expect(out).toEqual({ status: "rejected", reason: "cross_purpose" });
    assertValueLess(out);
  });

  // Spec: workspace challenge does NOT depend on financial consent
  // (indirectly tested: no channelConsentEpoch in workspace state type — TypeScript enforces this)

  // --- Multiple failures -----------------------------------------------------

  it("rejects when epoch stale, membership ended, and fence raised (value-less, any reason)", () => {
    const { record, state } = mkWorkspace(
      { authorizedEpoch: 5 },
      { authorizationEpoch: r("auth-OTHER"), accountActive: false, deletionFence: 50 }
    );
    const out = resolveAccountChallengeDelivery(record, state);
    expect(out.status).toBe("rejected");
    assertValueLess(out);
  });
});

// ===========================================================================
// SECURITY NOTICE DELIVERY
// ===========================================================================

describe("resolveSecurityNoticeDelivery — acceptance gate (spec §12 line 338)", () => {
  // --- Happy paths -----------------------------------------------------------

  it("resolves security-notice context with spec shape", () => {
    const { record, state } = mkNotice();
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({
      status: "resolved",
      context: {
        kind: "security_notice",
        purpose: "authenticated_security_notice",
        workspaceReference: "ws-ref-2",
        endpoint: "endpoint-2",
        expiresAt: T1,
      },
    });
    expect(out).not.toHaveProperty("reason");
    // No target in security-notice context (not in spec shape)
    if (out.status === "resolved") {
      expect(out.context).not.toHaveProperty("target");
    }
  });

  // Spec: security notice does NOT depend on financial consent or normal logout.
  // There is no channelConsentEpoch in SecurityNoticeState — enforced by TypeScript.

  // --- Deletion fence --------------------------------------------------------

  it("rejects value-less when fence equals authorizedEpoch (boundary)", () => {
    const { record, state } = mkNotice({ authorizedEpoch: 99 }, { deletionFence: 99 });
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "deletion_fenced" });
    assertValueLess(out);
  });

  it("rejects when fence exceeds authorizedEpoch", () => {
    const { record, state } = mkNotice({ authorizedEpoch: 99 }, { deletionFence: 200 });
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "deletion_fenced" });
    assertValueLess(out);
  });

  it("resolves when fence is strictly below authorizedEpoch (not fenced)", () => {
    const { record, state } = mkNotice({ authorizedEpoch: 99 }, { deletionFence: 98 });
    expect(resolveSecurityNoticeDelivery(record, state).status).toBe("resolved");
  });

  // --- Expiry boundary -------------------------------------------------------

  it("rejects when now === expiresAt (boundary)", () => {
    const { record, state } = mkNotice({ expiresAt: T_EXACT }, { now: T_EXACT });
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "expired" });
    assertValueLess(out);
  });

  it("rejects when expiresAt is in the past", () => {
    const { record, state } = mkNotice({ expiresAt: T_PAST });
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "expired" });
    assertValueLess(out);
  });

  // --- Individual failures ---------------------------------------------------

  it("rejects stale security-notice epoch (distinct epoch — NOT account authorization epoch)", () => {
    // Spec line 338 & 254: resolveSecurityNoticeDelivery re-checks its OWN
    // security-notice epoch, not the account authorization epoch.
    const { record, state } = mkNotice({}, { securityNoticeEpoch: r("sn-epoch-CHANGED") });
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "stale_epoch" });
    assertValueLess(out);
  });

  it("rejects changed membership revision (value-less)", () => {
    const { record, state } = mkNotice({}, { membershipRevision: r("mem-rev-CHANGED") });
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "membership_terminated" });
    assertValueLess(out);
  });

  it("rejects inactive account (value-less)", () => {
    const { record, state } = mkNotice({}, { accountActive: false });
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "membership_terminated" });
    assertValueLess(out);
  });

  it("rejects changed verified-address revision (value-less)", () => {
    const { record, state } = mkNotice({}, { endpointRevision: r("addr-rev-CHANGED") });
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "address_revision_changed" });
    assertValueLess(out);
  });

  // --- Cross-purpose ---------------------------------------------------------
  // Spec: two contexts cannot swap purpose; challenge purposes on notice resolver → cross_purpose

  it("rejects verify_email purpose on security-notice resolver as cross_purpose", () => {
    const { record, state } = mkNotice({ purpose: "verify_email" });
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "cross_purpose" });
    assertValueLess(out);
  });

  it("rejects pending_recovery purpose on security-notice resolver as cross_purpose", () => {
    const { record, state } = mkNotice({ purpose: "pending_recovery" });
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "cross_purpose" });
    assertValueLess(out);
  });

  it("rejects sign_in purpose on security-notice resolver as cross_purpose", () => {
    const { record, state } = mkNotice({ purpose: "sign_in" });
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "cross_purpose" });
    assertValueLess(out);
  });

  it("rejects recovery purpose on security-notice resolver as cross_purpose", () => {
    const { record, state } = mkNotice({ purpose: "recovery" });
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out).toEqual({ status: "rejected", reason: "cross_purpose" });
    assertValueLess(out);
  });

  // --- Multiple failures -----------------------------------------------------

  it("rejects when epoch stale, address changed, and expired simultaneously (value-less, any reason)", () => {
    const { record, state } = mkNotice(
      { expiresAt: T_PAST },
      { securityNoticeEpoch: r("sn-epoch-OTHER"), endpointRevision: r("addr-rev-OTHER") }
    );
    const out = resolveSecurityNoticeDelivery(record, state);
    expect(out.status).toBe("rejected");
    assertValueLess(out);
  });
});
