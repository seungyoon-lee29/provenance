import type { Brand, SourceReference } from "@/shared/contracts/brands";

import type { DeliveryCauseId } from "./contracts";

/**
 * F5 Delivery Intent — the Prevent layer for external delivery (spec §11).
 *
 * There are EXACTLY five allowed (cause, channel, source?, action-material?,
 * target) combinations. This module encodes them as a discriminated union of
 * `PlannedDeliveryIntent` variants — so an illegal combination cannot be
 * represented as a valid intent — and `planDeliveryIntent` rejects every other
 * variant BEFORE an intent exists, which is what keeps renderer/provider calls
 * at zero for disallowed requests.
 */
export type DeliveryActionMaterialReference = Brand<string, "DeliveryActionMaterialReference">;
export type DeliveryDestinationReference = Brand<string, "DeliveryDestinationReference">;

export type SecurityPurpose =
  | "verify_email"
  | "pending_recovery"
  | "sign_in"
  | "recovery"
  | "authenticated_security_notice";

export type DeliveryCause =
  | Readonly<{ kind: "alert_occurrence"; causeId: DeliveryCauseId }>
  | Readonly<{ kind: "account_security_event"; causeId: DeliveryCauseId; purpose: SecurityPurpose }>;

export type DeliveryChannel = "email" | "web_push";

export type DeliveryTarget = Readonly<{
  kind:
    | "workspace_financial_email"
    | "workspace_security_email"
    | "workspace_web_push"
    | "pending_account_email";
  reference: DeliveryDestinationReference;
  /** Keyed fingerprint of the destination; the raw target never leaves the vault. */
  destinationFingerprint: string;
}>;

export type DeliveryActionMaterial = Readonly<{
  kind: "account_challenge" | "unsubscribe";
  reference: DeliveryActionMaterialReference;
}>;

/** Immutable delivery parameters fixed at intent time and never re-derived. */
export type DeliveryPayloadBinding = Readonly<{
  templateRevision: string;
  payloadHash: string;
  expiresAt: string;
}>;

export type DeliveryIntentRequest = Readonly<{
  cause: DeliveryCause;
  channel: DeliveryChannel;
  source?: SourceReference;
  actionMaterial?: DeliveryActionMaterial;
  target: DeliveryTarget;
  binding: DeliveryPayloadBinding;
}>;

export type DeliveryIntentVariant =
  | "financial_email"
  | "financial_web_push"
  | "pending_account_challenge"
  | "workspace_account_challenge"
  | "authenticated_security_notice";

export type PlannedDeliveryIntent = Readonly<{
  variant: DeliveryIntentVariant;
  cause: DeliveryCause;
  channel: DeliveryChannel;
  source?: SourceReference;
  actionMaterial?: DeliveryActionMaterial;
  target: DeliveryTarget;
  binding: DeliveryPayloadBinding;
  /** `(causeId, channel, destinationFingerprint)` — the idempotent outbox identity. */
  uniqueKey: string;
}>;

export type DeliveryIntentRejection =
  | "unsupported_channel_for_cause"
  | "cause_channel_target_mismatch"
  | "missing_source"
  | "unexpected_source"
  | "missing_action_material"
  | "unexpected_action_material"
  | "wrong_action_material_kind"
  | "purpose_target_mismatch";

export type DeliveryIntentOutcome =
  | Readonly<{ status: "planned"; intent: PlannedDeliveryIntent }>
  | Readonly<{ status: "rejected"; reason: DeliveryIntentRejection }>;

function uniqueKey(request: DeliveryIntentRequest): string {
  return `${request.cause.causeId}|${request.channel}|${request.target.destinationFingerprint}`;
}

function planned(request: DeliveryIntentRequest, variant: DeliveryIntentVariant): DeliveryIntentOutcome {
  return {
    status: "planned",
    intent: {
      variant,
      cause: request.cause,
      channel: request.channel,
      source: request.source,
      actionMaterial: request.actionMaterial,
      target: request.target,
      binding: request.binding,
      uniqueKey: uniqueKey(request),
    },
  };
}

const reject = (reason: DeliveryIntentRejection): DeliveryIntentOutcome => ({ status: "rejected", reason });

/**
 * Validate a delivery request against the five-row allowlist. Any combination
 * outside the table is rejected before an intent exists — no renderer or
 * provider is reached for a rejected request.
 */
export function planDeliveryIntent(request: DeliveryIntentRequest): DeliveryIntentOutcome {
  const { cause, channel, source, actionMaterial, target } = request;

  if (cause.kind === "alert_occurrence") {
    // Rows 1-2: financial alert delivery always carries the Evidence source.
    if (source === undefined) return reject("missing_source");
    if (channel === "email") {
      if (target.kind !== "workspace_financial_email") return reject("cause_channel_target_mismatch");
      if (actionMaterial === undefined) return reject("missing_action_material");
      if (actionMaterial.kind !== "unsubscribe") return reject("wrong_action_material_kind");
      return planned(request, "financial_email");
    }
    // web_push
    if (target.kind !== "workspace_web_push") return reject("cause_channel_target_mismatch");
    if (actionMaterial !== undefined) return reject("unexpected_action_material");
    return planned(request, "financial_web_push");
  }

  // account_security_event — email only, never carries a source.
  if (channel !== "email") return reject("unsupported_channel_for_cause");
  if (source !== undefined) return reject("unexpected_source");

  if (cause.purpose === "authenticated_security_notice") {
    // Row 5: allowlisted notice, no action material.
    if (target.kind !== "workspace_security_email") return reject("purpose_target_mismatch");
    if (actionMaterial !== undefined) return reject("unexpected_action_material");
    return planned(request, "authenticated_security_notice");
  }

  // Rows 3-4: account challenge always carries account-challenge material.
  if (actionMaterial === undefined) return reject("missing_action_material");
  if (actionMaterial.kind !== "account_challenge") return reject("wrong_action_material_kind");

  if (cause.purpose === "verify_email" || cause.purpose === "pending_recovery") {
    // Row 3: pre-account challenge to a pending target.
    if (target.kind !== "pending_account_email") return reject("purpose_target_mismatch");
    return planned(request, "pending_account_challenge");
  }
  // sign_in | recovery — Row 4: verified existing account.
  if (target.kind !== "workspace_security_email") return reject("purpose_target_mismatch");
  return planned(request, "workspace_account_challenge");
}
