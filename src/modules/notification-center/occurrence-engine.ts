import { brandReference } from "../../shared/contracts/brands";
import type { WorkspaceReference } from "@/shared/contracts/brands";

import { FencedKeyedStore } from "./fenced-store";
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

export type OccurrenceErasureReceipt = Readonly<{ occurrences: number; records: number }>;

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
  /**
   * Administrative erasure (SEC-09): shred the workspace's Notification Records,
   * Alert Occurrences and rule watermark/state behind a deletion fence. A write
   * belonging to an epoch at or below `fence` is thereafter suppressed, so a late
   * worker/webhook replay or a backup restore cannot regenerate personal state.
   */
  eraseWorkspace(workspace: WorkspaceReference, fence: number): OccurrenceErasureReceipt;
}

export function createOccurrenceStore(now: () => string, options: { writeEpoch?: number } = {}): OccurrenceStore {
  // ponytail: a single store-level write epoch; a genuinely new post-erasure
  // authorized epoch is a fresh store/context (B6 coordinator wires that).
  const writeEpoch = options.writeEpoch ?? 1;
  const states = new Map<string, RuleState>();
  const occurrences = new FencedKeyedStore<AlertOccurrence>();
  const records = new FencedKeyedStore<NotificationRecord>();

  return {
    registerRule(rule) {
      // Restore suppression: no re-registering an erased workspace at an old
      // epoch. This keeps the transition write below always unsuppressed (a
      // fenced workspace has no live rule to observe), so no occurrence is
      // silently dropped after being reported.
      if (records.isErased(rule.workspaceReference, writeEpoch)) return;
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
        // Synchronous fenced writes keep the critical section atomic; the write
        // epoch is above the (0) fence for any live rule, so neither is suppressed.
        occurrences.write(state.rule.workspaceReference, occurrence.occurrenceReference, occurrence, writeEpoch);
        records.write(state.rule.workspaceReference, record.recordReference, record, writeEpoch);
        return { kind: "transition", occurrence, record };
      }

      const reason = observation.conditionMet ? "still_true" : wasTrue ? "cleared" : "still_false";
      return { kind: "no_transition", reason };
    },

    listRecords(workspace) {
      return records.list(workspace);
    },

    listOccurrences(rule) {
      // Occurrences are stored per workspace; resolve it from the rule state
      // (absent once the workspace is erased → no occurrences to list).
      const state = states.get(rule);
      if (!state) return [];
      return occurrences.list(state.rule.workspaceReference).filter((occurrence) => occurrence.ruleReference === rule);
    },

    eraseWorkspace(workspace, fence) {
      for (const [ruleReference, state] of states) {
        if (state.rule.workspaceReference === workspace) states.delete(ruleReference);
      }
      return {
        occurrences: occurrences.eraseSubject(workspace, fence),
        records: records.eraseSubject(workspace, fence),
      };
    },
  };
}
