import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { createOccurrenceStore } from "../src/modules/notification-center/occurrence-engine";
import type { AlertObservation, AlertRule, AlertRuleReference } from "../src/modules/notification-center/contracts";

const FIXED_NOW = "2026-01-02T14:30:00.000Z";
const rule: AlertRule = {
  ruleReference: brandReference<string, "AlertRuleReference">("rule:aapl-gt-200"),
  workspaceReference: brandReference<string, "WorkspaceReference">("workspace:w1"),
  conditionRevision: "cr-1",
};

function store() {
  const s = createOccurrenceStore(() => FIXED_NOW);
  s.registerRule(rule);
  return s;
}

function obs(input: Partial<AlertObservation> & Pick<AlertObservation, "conditionMet" | "sourceObservationIdentity">): AlertObservation {
  return {
    ruleReference: rule.ruleReference,
    conditionRevision: "cr-1",
    asOf: FIXED_NOW,
    ...input,
  };
}

describe("Alert Occurrence exactly-once spine (spec §11, AT-10 core)", () => {
  it("a serial false→true edge creates exactly one occurrence and one record", async () => {
    const s = store();
    const result = await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    expect(result.kind).toBe("transition");
    expect(s.listOccurrences(rule.ruleReference)).toHaveLength(1);
    expect(s.listRecords(rule.workspaceReference)).toHaveLength(1);
    if (result.kind === "transition") {
      expect(result.occurrence.transitionSequence).toBe(1);
      expect(result.occurrence.causeId).toBe(result.record.causeId);
      expect(result.record.read).toBe(false);
      expect(result.record.triggeredAt).toBe(FIXED_NOW);
    }
  });

  it("a sustained true (true→true) creates no new occurrence", async () => {
    const s = store();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    const again = await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 2 }));
    expect(again).toEqual({ kind: "no_transition", reason: "still_true" });
    expect(s.listOccurrences(rule.ruleReference)).toHaveLength(1);
  });

  it("a replayed observation is ignored and does not roll the watermark back", async () => {
    const s = store();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 5 }));
    // an out-of-order/late observation at an older identity is ignored...
    const late = await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 3 }));
    expect(late).toEqual({ kind: "ignored", reason: "stale_observation" });
    // ...and the watermark is preserved: a re-send at identity 5 is still a replay.
    const replay = await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 5 }));
    expect(replay).toEqual({ kind: "ignored", reason: "stale_observation" });
    expect(s.listOccurrences(rule.ruleReference)).toHaveLength(1);
  });

  it("false→true→false→true yields two distinct occurrences", async () => {
    const s = store();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 2 }));
    const second = await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 3 }));
    expect(second.kind).toBe("transition");
    const all = s.listOccurrences(rule.ruleReference);
    expect(all.map((o) => o.transitionSequence)).toEqual([1, 2]);
    expect(new Set(all.map((o) => o.causeId)).size).toBe(2);
  });

  it("an observation for an unregistered rule is ignored", async () => {
    const s = store();
    const unknown: AlertRuleReference = brandReference<string, "AlertRuleReference">("rule:unknown");
    const result = await s.observe({ ruleReference: unknown, conditionRevision: "cr-1", conditionMet: true, sourceObservationIdentity: 1, asOf: FIXED_NOW });
    expect(result).toEqual({ kind: "ignored", reason: "unknown_rule" });
  });

  it("a new condition revision starts effectively false so its first true fires", async () => {
    const s = store();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    // same rule, new condition revision, still true → counts as a fresh false→true.
    const fresh = await s.observe({ ruleReference: rule.ruleReference, conditionRevision: "cr-2", conditionMet: true, sourceObservationIdentity: 2, asOf: FIXED_NOW });
    expect(fresh.kind).toBe("transition");
    expect(s.listOccurrences(rule.ruleReference)).toHaveLength(2);
  });

  it("100 concurrent observations of the same transition create exactly one occurrence", async () => {
    const s = store();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }))),
    );
    expect(results.filter((r) => r.kind === "transition")).toHaveLength(1);
    expect(s.listOccurrences(rule.ruleReference)).toHaveLength(1);
    expect(s.listRecords(rule.workspaceReference)).toHaveLength(1);
  });
});
