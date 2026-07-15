import type { Brand, WorkspaceReference } from "@/shared/contracts/brands";

/**
 * F5 NotificationCenter — module-internal contracts for the exactly-once alert
 * spine (B1). Delivery Cause is the tagged identity of an Alert Occurrence (or,
 * later, an Account Security Event) and is the dedupe/audit source of truth for
 * downstream Delivery Intents (B2+). References are branded so an id for one
 * kind cannot stand in for another.
 */
export type AlertRuleReference = Brand<string, "AlertRuleReference">;
export type AlertOccurrenceReference = Brand<string, "AlertOccurrenceReference">;
export type NotificationRecordReference = Brand<string, "NotificationRecordReference">;
export type DeliveryCauseId = Brand<string, "DeliveryCauseId">;

export type AlertRule = Readonly<{
  ruleReference: AlertRuleReference;
  workspaceReference: WorkspaceReference;
  conditionRevision: string;
}>;

/**
 * A typed condition input for one Alert Rule at one observation point. Upstream
 * (FinancialInformation/Portfolio `AlertObservationResolver`) has already
 * re-resolved the purpose-bound reference under the Viewer Context; the engine
 * never reads raw provider payload. `sourceObservationIdentity` is monotonic per
 * rule so replays and late observations cannot recreate a transition or roll the
 * rule watermark back.
 */
export type AlertObservation = Readonly<{
  ruleReference: AlertRuleReference;
  conditionRevision: string;
  conditionMet: boolean;
  sourceObservationIdentity: number;
  asOf: string;
}>;

export type AlertOccurrence = Readonly<{
  occurrenceReference: AlertOccurrenceReference;
  causeId: DeliveryCauseId;
  ruleReference: AlertRuleReference;
  workspaceReference: WorkspaceReference;
  conditionRevision: string;
  transitionSequence: number;
  sourceObservationIdentity: number;
  occurredAt: string;
}>;

/**
 * The in-app canonical record. It survives external delivery failure/unsubscribe
 * and is only mutated by a foreground acknowledgement (read/dismiss) — never by
 * a Delivery Fact.
 */
export type NotificationRecord = Readonly<{
  recordReference: NotificationRecordReference;
  workspaceReference: WorkspaceReference;
  causeId: DeliveryCauseId;
  occurrenceReference: AlertOccurrenceReference;
  triggeredAt: string;
  createdAt: string;
  read: boolean;
  dismissed: boolean;
}>;

export type ObserveResult =
  | Readonly<{ kind: "transition"; occurrence: AlertOccurrence; record: NotificationRecord }>
  | Readonly<{ kind: "no_transition"; reason: "still_true" | "still_false" | "cleared" }>
  | Readonly<{ kind: "ignored"; reason: "stale_observation" | "unknown_rule" }>;
