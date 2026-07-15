import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { planDeliveryIntent } from "../src/modules/notification-center/delivery-intent";
import type {
  DeliveryActionMaterial,
  DeliveryCause,
  DeliveryIntentRejection,
  DeliveryIntentRequest,
  DeliveryTarget,
  SecurityPurpose,
} from "../src/modules/notification-center/delivery-intent";
import type { SourceReference } from "@/shared/contracts/brands";

const source: SourceReference = brandReference<string, "SourceReference">("source:evidence:1");
const binding = { templateRevision: "tpl-1", payloadHash: "hash-1", expiresAt: "2026-01-02T15:00:00.000Z" };

const alertCause: DeliveryCause = { kind: "alert_occurrence", causeId: brandReference<string, "DeliveryCauseId">("cause:alert:rule:1") };
function securityCause(purpose: SecurityPurpose): DeliveryCause {
  return { kind: "account_security_event", causeId: brandReference<string, "DeliveryCauseId">("cause:sec:e1"), purpose };
}

function target(kind: DeliveryTarget["kind"]): DeliveryTarget {
  return { kind, reference: brandReference<string, "DeliveryDestinationReference">(`dest:${kind}`), destinationFingerprint: `fp:${kind}` };
}
function material(kind: DeliveryActionMaterial["kind"]): DeliveryActionMaterial {
  return { kind, reference: brandReference<string, "DeliveryActionMaterialReference">(`mat:${kind}`) };
}
function request(input: Partial<DeliveryIntentRequest> & Pick<DeliveryIntentRequest, "cause" | "channel" | "target">): DeliveryIntentRequest {
  return { binding, ...input };
}

describe("Delivery Intent 5-tuple allowlist (Prevent, spec §11 line 337 / AT-10)", () => {
  it("row 1: financial email = alert + email + source + unsubscribe + financial email target", () => {
    const out = planDeliveryIntent(request({ cause: alertCause, channel: "email", source, actionMaterial: material("unsubscribe"), target: target("workspace_financial_email") }));
    expect(out.status).toBe("planned");
    if (out.status === "planned") {
      expect(out.intent.variant).toBe("financial_email");
      expect(out.intent.uniqueKey).toBe("cause:alert:rule:1|email|fp:workspace_financial_email");
    }
  });

  it("row 2: financial web push = alert + web_push + source + no action + web push target", () => {
    const out = planDeliveryIntent(request({ cause: alertCause, channel: "web_push", source, target: target("workspace_web_push") }));
    expect(out).toMatchObject({ status: "planned", intent: { variant: "financial_web_push" } });
  });

  it("row 3: pending account challenge = verify_email + email + no source + account_challenge + pending target", () => {
    const out = planDeliveryIntent(request({ cause: securityCause("verify_email"), channel: "email", actionMaterial: material("account_challenge"), target: target("pending_account_email") }));
    expect(out).toMatchObject({ status: "planned", intent: { variant: "pending_account_challenge" } });
  });

  it("row 4: workspace account challenge = sign_in + email + no source + account_challenge + security email target", () => {
    const out = planDeliveryIntent(request({ cause: securityCause("sign_in"), channel: "email", actionMaterial: material("account_challenge"), target: target("workspace_security_email") }));
    expect(out).toMatchObject({ status: "planned", intent: { variant: "workspace_account_challenge" } });
  });

  it("row 5: authenticated security notice = notice + email + no source + no action + security email target", () => {
    const out = planDeliveryIntent(request({ cause: securityCause("authenticated_security_notice"), channel: "email", target: target("workspace_security_email") }));
    expect(out).toMatchObject({ status: "planned", intent: { variant: "authenticated_security_notice" } });
  });

  const forbidden: ReadonlyArray<Readonly<{ name: string; request: DeliveryIntentRequest; reason: DeliveryIntentRejection }>> = [
    { name: "alert email without source", reason: "missing_source", request: request({ cause: alertCause, channel: "email", actionMaterial: material("unsubscribe"), target: target("workspace_financial_email") }) },
    { name: "alert email without unsubscribe material", reason: "missing_action_material", request: request({ cause: alertCause, channel: "email", source, target: target("workspace_financial_email") }) },
    { name: "alert email with wrong material kind", reason: "wrong_action_material_kind", request: request({ cause: alertCause, channel: "email", source, actionMaterial: material("account_challenge"), target: target("workspace_financial_email") }) },
    { name: "alert email to web push target", reason: "cause_channel_target_mismatch", request: request({ cause: alertCause, channel: "email", source, actionMaterial: material("unsubscribe"), target: target("workspace_web_push") }) },
    { name: "alert web push with action material", reason: "unexpected_action_material", request: request({ cause: alertCause, channel: "web_push", source, actionMaterial: material("unsubscribe"), target: target("workspace_web_push") }) },
    { name: "alert web push to financial email target", reason: "cause_channel_target_mismatch", request: request({ cause: alertCause, channel: "web_push", source, target: target("workspace_financial_email") }) },
    { name: "security via web push", reason: "unsupported_channel_for_cause", request: request({ cause: securityCause("sign_in"), channel: "web_push", target: target("workspace_web_push") }) },
    { name: "security with a source", reason: "unexpected_source", request: request({ cause: securityCause("sign_in"), channel: "email", source, actionMaterial: material("account_challenge"), target: target("workspace_security_email") }) },
    { name: "verify_email to workspace target", reason: "purpose_target_mismatch", request: request({ cause: securityCause("verify_email"), channel: "email", actionMaterial: material("account_challenge"), target: target("workspace_security_email") }) },
    { name: "sign_in to pending target", reason: "purpose_target_mismatch", request: request({ cause: securityCause("sign_in"), channel: "email", actionMaterial: material("account_challenge"), target: target("pending_account_email") }) },
    { name: "challenge without material", reason: "missing_action_material", request: request({ cause: securityCause("sign_in"), channel: "email", target: target("workspace_security_email") }) },
    { name: "challenge with unsubscribe material", reason: "wrong_action_material_kind", request: request({ cause: securityCause("sign_in"), channel: "email", actionMaterial: material("unsubscribe"), target: target("workspace_security_email") }) },
    { name: "notice with action material", reason: "unexpected_action_material", request: request({ cause: securityCause("authenticated_security_notice"), channel: "email", actionMaterial: material("account_challenge"), target: target("workspace_security_email") }) },
    { name: "notice to pending target", reason: "purpose_target_mismatch", request: request({ cause: securityCause("authenticated_security_notice"), channel: "email", target: target("pending_account_email") }) },
  ];

  for (const entry of forbidden) {
    it(`rejects ${entry.name} → ${entry.reason} (no intent)`, () => {
      expect(planDeliveryIntent(entry.request)).toEqual({ status: "rejected", reason: entry.reason });
    });
  }
});
