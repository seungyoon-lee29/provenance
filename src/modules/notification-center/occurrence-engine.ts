import { brandReference } from "../../shared/contracts/brands";
import type { WorkspaceReference } from "@/shared/contracts/brands";

import type {
  AlertObservation,
  AlertOccurrence,
  AlertRule,
  AlertRuleReference,
  NotificationRecord,
  ObserveResult,
} from "./contracts";

type RuleState = {
  rule: AlertRule;
  lastConditionState: boolean;
  lastConditionRevision: string;
  lastObservationIdentity: number;
  transitionSequence: number;
};

export interface OccurrenceStore {
  registerRule(rule: AlertRule): void;
  /**
   * Apply one observation to its rule. A serial false→true edge materializes
   * exactly one Alert Occurrence + Notification Record; every replay, late or
   * out-of-order observation (identity ≤ watermark) is ignored without a new
   * transition and without rolling the watermark back. The read-guard-advance-
   * create critical section runs synchronously after a single await, so 100
   * concurrent calls for the same transition still yield exactly one occurrence.
   */
  observe(observation: AlertObservation): Promise<ObserveResult>;
  listRecords(workspace: WorkspaceReference): readonly NotificationRecord[];
  listOccurrences(rule: AlertRuleReference): readonly AlertOccurrence[];
}

export function createOccurrenceStore(now: () => string): OccurrenceStore {
  const states = new Map<string, RuleState>();
  const occurrences: AlertOccurrence[] = [];
  const records: NotificationRecord[] = [];

  return {
    registerRule(rule) {
      if (states.has(rule.ruleReference)) return;
      states.set(rule.ruleReference, {
        rule,
        lastConditionState: false,
        lastConditionRevision: rule.conditionRevision,
        lastObservationIdentity: -1,
        transitionSequence: 0,
      });
    },

    async observe(observation) {
      // Model the async seam boundary; the atomic apply below re-reads live state.
      await Promise.resolve();
      const state = states.get(observation.ruleReference);
      if (!state) return { kind: "ignored", reason: "unknown_rule" };

      // Watermark guard: a replayed/late/out-of-order observation cannot recreate
      // a transition or move the watermark backward.
      if (observation.sourceObservationIdentity <= state.lastObservationIdentity) {
        return { kind: "ignored", reason: "stale_observation" };
      }

      // A new condition revision starts effectively false, so its first true fires.
      const revisionChanged = observation.conditionRevision !== state.lastConditionRevision;
      const wasTrue = revisionChanged ? false : state.lastConditionState;

      // Advance the watermark atomically (no await from here to the return).
      state.lastObservationIdentity = observation.sourceObservationIdentity;
      state.lastConditionState = observation.conditionMet;
      state.lastConditionRevision = observation.conditionRevision;

      if (!wasTrue && observation.conditionMet) {
        const seq = state.transitionSequence + 1;
        state.transitionSequence = seq;
        const occurredAt = now();
        const causeId = brandReference<string, "DeliveryCauseId">(`cause:alert:${observation.ruleReference}:${seq}`);
        const occurrence: AlertOccurrence = {
          occurrenceReference: brandReference<string, "AlertOccurrenceReference">(`occurrence:${observation.ruleReference}:${seq}`),
          causeId,
          ruleReference: observation.ruleReference,
          workspaceReference: state.rule.workspaceReference,
          conditionRevision: observation.conditionRevision,
          transitionSequence: seq,
          sourceObservationIdentity: observation.sourceObservationIdentity,
          occurredAt,
        };
        const record: NotificationRecord = {
          recordReference: brandReference<string, "NotificationRecordReference">(`record:${observation.ruleReference}:${seq}`),
          workspaceReference: state.rule.workspaceReference,
          causeId,
          occurrenceReference: occurrence.occurrenceReference,
          triggeredAt: observation.asOf,
          createdAt: occurredAt,
          read: false,
          dismissed: false,
        };
        occurrences.push(occurrence);
        records.push(record);
        return { kind: "transition", occurrence, record };
      }

      const reason = observation.conditionMet ? "still_true" : wasTrue ? "cleared" : "still_false";
      return { kind: "no_transition", reason };
    },

    listRecords(workspace) {
      return records.filter((record) => record.workspaceReference === workspace);
    },

    listOccurrences(rule) {
      return occurrences.filter((occurrence) => occurrence.ruleReference === rule);
    },
  };
}
