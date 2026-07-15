import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { DeliveryOutbox } from "../src/modules/notification-center/delivery-outbox";
import { planDeliveryIntent } from "../src/modules/notification-center/delivery-intent";
import type { DeliveryIntentRequest, PlannedDeliveryIntent } from "../src/modules/notification-center/delivery-intent";
import type { SourceReference } from "@/shared/contracts/brands";

const WS = "workspace:w1";
const source: SourceReference = brandReference<string, "SourceReference">("source:ev:1");

function financialEmailRequest(fingerprint = "fp:alice"): DeliveryIntentRequest {
  return {
    cause: { kind: "alert_occurrence", causeId: brandReference<string, "DeliveryCauseId">("cause:alert:rule:1") },
    channel: "email",
    source,
    actionMaterial: { kind: "unsubscribe", reference: brandReference<string, "DeliveryActionMaterialReference">("mat:unsub:1") },
    target: { kind: "workspace_financial_email", reference: brandReference<string, "DeliveryDestinationReference">("dest:1"), destinationFingerprint: fingerprint },
    binding: { templateRevision: "tpl-1", payloadHash: "hash-1", expiresAt: "2026-01-02T15:00:00.000Z" },
  };
}

function plan(request: DeliveryIntentRequest): PlannedDeliveryIntent {
  const out = planDeliveryIntent(request);
  if (out.status !== "planned") throw new Error(`expected planned, got ${out.status}`);
  return out.intent;
}

describe("DeliveryOutbox — durable idempotent commit before dispatch (spec §11)", () => {
  it("commits a planned intent once and dedupes a replay on the same unique key", () => {
    const outbox = new DeliveryOutbox();
    const intent = plan(financialEmailRequest());
    expect(outbox.commit(WS, intent, 1)).toEqual({ status: "committed", intent });
    // a replayed commit (stream/poll/retry) is idempotent — no second intent.
    expect(outbox.commit(WS, intent, 1).status).toBe("duplicate");
    expect(outbox.list(WS)).toHaveLength(1);
  });

  it("100 concurrent-style repeated commits of the same intent yield exactly one committed", () => {
    const outbox = new DeliveryOutbox();
    const intent = plan(financialEmailRequest());
    const results = Array.from({ length: 100 }, () => outbox.commit(WS, intent, 1));
    expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(99);
    expect(outbox.list(WS)).toHaveLength(1);
  });

  it("distinct destinations are distinct intents", () => {
    const outbox = new DeliveryOutbox();
    outbox.commit(WS, plan(financialEmailRequest("fp:alice")), 1);
    outbox.commit(WS, plan(financialEmailRequest("fp:bob")), 1);
    expect(outbox.list(WS)).toHaveLength(2);
  });

  it("a commit for an erased subject is suppressed and never re-materializes", () => {
    const outbox = new DeliveryOutbox();
    const intent = plan(financialEmailRequest());
    outbox.commit(WS, intent, 1);
    expect(outbox.eraseSubject(WS, 5)).toBe(1);
    // late worker/backup restore at an old epoch → suppressed, no intent.
    expect(outbox.commit(WS, intent, 3)).toEqual({ status: "suppressed" });
    expect(outbox.list(WS)).toHaveLength(0);
    // a genuinely new authorized epoch may commit again.
    expect(outbox.commit(WS, intent, 6).status).toBe("committed");
  });
});
