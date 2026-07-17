import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceReference } from "@/shared/contracts/brands";
import { createOccurrenceStore } from "../src/modules/notification-center/occurrence-engine";
import type { AlertRule, NotificationRecord } from "../src/modules/notification-center/contracts";
import { DeliveryFactLog } from "../src/modules/notification-center/delivery-fact";
import type { DeliveryFactInput } from "../src/modules/notification-center/delivery-fact";
import { presentInbox } from "../src/modules/notification-center/inbox-presenter";

const WS = brandReference<string, "WorkspaceReference">("workspace:w1") as WorkspaceReference;
const NOW = "2026-01-02T10:00:00.000Z";

function rule(reference = "rule:r1"): AlertRule {
  return {
    ruleReference: brandReference<string, "AlertRuleReference">(reference),
    workspaceReference: WS,
    conditionRevision: "rev-1",
  } as AlertRule;
}

async function transition(store: ReturnType<typeof createOccurrenceStore>, ruleReference = "rule:r1", identity = 1) {
  const result = await store.observe({
    ruleReference: brandReference<string, "AlertRuleReference">(ruleReference),
    conditionRevision: "rev-1",
    conditionMet: true,
    sourceObservationIdentity: identity,
    asOf: NOW,
  });
  if (result.kind !== "transition") throw new Error(`expected transition, got ${result.kind}`);
  return result;
}

function fact(causeId: string, kind: DeliveryFactInput["kind"]): DeliveryFactInput {
  return {
    causeId: brandReference<string, "DeliveryCauseId">(causeId),
    intentUniqueKey: `${causeId}|email|fp:x`,
    kind,
    occurredAt: NOW,
  };
}

describe("NotificationRecord acknowledgement (UF-08: in-app record is canonical)", () => {
  it("acknowledge read marks the record read without touching the occurrence", async () => {
    const store = createOccurrenceStore(() => NOW);
    store.registerRule(rule());
    const { record, occurrence } = await transition(store);
    expect(record.read).toBe(false);
    expect(store.acknowledge(WS, record.recordReference, "read")).toBe(true);
    const stored = store.listRecords(WS);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.read).toBe(true);
    expect(stored[0]?.dismissed).toBe(false);
    expect(store.listOccurrences(occurrence.ruleReference)).toHaveLength(1);
  });

  it("acknowledge is idempotent and false for an unknown record", async () => {
    const store = createOccurrenceStore(() => NOW);
    store.registerRule(rule());
    const { record } = await transition(store);
    expect(store.acknowledge(WS, record.recordReference, "dismiss")).toBe(true);
    expect(store.acknowledge(WS, record.recordReference, "dismiss")).toBe(true);
    expect(store.listRecords(WS)[0]?.dismissed).toBe(true);
    const unknown = brandReference<string, "NotificationRecordReference">("record:nope:9");
    expect(store.acknowledge(WS, unknown, "read")).toBe(false);
  });

  it("acknowledge after administrative erasure regenerates nothing (SEC-09)", async () => {
    const store = createOccurrenceStore(() => NOW);
    store.registerRule(rule());
    const { record } = await transition(store);
    store.eraseWorkspace(WS, 1);
    expect(store.acknowledge(WS, record.recordReference, "read")).toBe(false);
    expect(store.listRecords(WS)).toEqual([]);
  });
});

describe("inbox presenter (WS-06: status by name, no promotion)", () => {
  function records(store: ReturnType<typeof createOccurrenceStore>): readonly NotificationRecord[] {
    return store.listRecords(WS);
  }

  it("orders cards newest first and counts unread, excluding dismissed cards", async () => {
    const store = createOccurrenceStore(() => NOW);
    store.registerRule(rule("rule:a"));
    store.registerRule(rule("rule:b"));
    const first = await store.observe({
      ruleReference: brandReference<string, "AlertRuleReference">("rule:a"),
      conditionRevision: "rev-1",
      conditionMet: true,
      sourceObservationIdentity: 1,
      asOf: "2026-01-02T09:00:00.000Z",
    });
    const second = await store.observe({
      ruleReference: brandReference<string, "AlertRuleReference">("rule:b"),
      conditionRevision: "rev-1",
      conditionMet: true,
      sourceObservationIdentity: 1,
      asOf: "2026-01-02T10:00:00.000Z",
    });
    if (first.kind !== "transition" || second.kind !== "transition") throw new Error("expected transitions");
    store.acknowledge(WS, first.record.recordReference, "read");

    const view = presentInbox(records(store), []);
    expect(view.totalCount).toBe(2);
    expect(view.unreadCount).toBe(1);
    expect(view.cards.map((card) => card.causeId)).toEqual([String(second.record.causeId), String(first.record.causeId)]);
    expect(view.announcement).toContain("1");

    store.acknowledge(WS, second.record.recordReference, "dismiss");
    const afterDismiss = presentInbox(records(store), []);
    expect(afterDismiss.totalCount).toBe(2);
    expect(afterDismiss.cards).toHaveLength(1);
    expect(afterDismiss.unreadCount).toBe(0);
  });

  it("provider_accepted is presented as acceptance, NEVER as delivered/seen (no promotion)", async () => {
    const store = createOccurrenceStore(() => NOW);
    store.registerRule(rule());
    const { record } = await transition(store);
    const facts = new DeliveryFactLog();
    facts.append("workspace:w1", fact(String(record.causeId), "queued"), 1);
    facts.append("workspace:w1", fact(String(record.causeId), "provider_accepted"), 1);

    const view = presentInbox(records(store), facts.list("workspace:w1"));
    const card = view.cards[0];
    expect(card?.deliveryStatus).toBe("provider_accepted");
    expect(card?.deliveryStatusLabel).toBe("발송 접수");
    expect(card?.deliveryStatusLabel).not.toContain("전달");
    expect(card?.deliveryStatusLabel).not.toContain("확인");
  });

  it("delivered/seen labels only appear when those facts were actually recorded", async () => {
    const store = createOccurrenceStore(() => NOW);
    store.registerRule(rule());
    const { record } = await transition(store);
    const facts = new DeliveryFactLog();
    facts.append("workspace:w1", fact(String(record.causeId), "provider_accepted"), 1);
    facts.append("workspace:w1", fact(String(record.causeId), "delivered"), 1);
    const view = presentInbox(records(store), facts.list("workspace:w1"));
    expect(view.cards[0]?.deliveryStatusLabel).toBe("전달됨");
  });

  it("a record with no delivery facts is in-app only — a normal, named state", async () => {
    const store = createOccurrenceStore(() => NOW);
    store.registerRule(rule());
    await transition(store);
    const view = presentInbox(records(store), []);
    expect(view.cards[0]?.deliveryStatus).toBe("none");
    expect(view.cards[0]?.deliveryStatusLabel).toBe("인앱 표시");
  });

  it("facts from another cause never leak onto a record", async () => {
    const store = createOccurrenceStore(() => NOW);
    store.registerRule(rule());
    const { record } = await transition(store);
    const facts = new DeliveryFactLog();
    facts.append("workspace:w1", fact("cause:alert:other:1", "failed"), 1);
    const view = presentInbox(records(store), facts.list("workspace:w1"));
    expect(view.cards[0]?.causeId).toBe(String(record.causeId));
    expect(view.cards[0]?.deliveryStatus).toBe("none");
  });

  it("every card carries a non-empty status name and tone (WS-06: never color alone)", async () => {
    const store = createOccurrenceStore(() => NOW);
    store.registerRule(rule());
    const { record } = await transition(store);
    const facts = new DeliveryFactLog();
    for (const kind of ["queued", "delayed", "bounced", "suppressed", "expired", "failed", "complained", "provider_suppressed"] as const) {
      facts.append("workspace:w1", fact(String(record.causeId), kind), 1);
    }
    const view = presentInbox(records(store), facts.list("workspace:w1"));
    const card = view.cards[0];
    expect(card?.deliveryStatusLabel.length ?? 0).toBeGreaterThan(0);
    expect(["progress", "done", "muted", "problem", "none"]).toContain(card?.deliveryTone);
  });
});
