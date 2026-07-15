/**
 * B2.5b — the exactly-once spine's records/occurrences sit on the fenced
 * substrate, so administrative erasure shreds them structurally and no late
 * replay or backup restore regenerates personal delivery state.
 * Source of truth: SEC-09 / spec §12 (regeneration = 0).
 */

import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { createOccurrenceStore } from "../src/modules/notification-center/occurrence-engine";
import type { AlertObservation, AlertRule } from "../src/modules/notification-center/contracts";
import type { WorkspaceReference } from "@/shared/contracts/brands";

const NOW = "2026-07-16T00:00:00.000Z";
const WS_A = brandReference<string, "WorkspaceReference">("workspace:a");
const WS_B = brandReference<string, "WorkspaceReference">("workspace:b");

function ruleFor(ws: WorkspaceReference, id: string): AlertRule {
  return {
    ruleReference: brandReference<string, "AlertRuleReference">(id),
    workspaceReference: ws,
    conditionRevision: "rev-1",
  };
}

function obs(
  rule: AlertRule,
  overrides: Partial<AlertObservation> & Pick<AlertObservation, "conditionMet" | "sourceObservationIdentity">,
): AlertObservation {
  return { ruleReference: rule.ruleReference, conditionRevision: "rev-1", asOf: NOW, ...overrides };
}

describe("Occurrence spine erasure (SEC-09, B2.5b)", () => {
  it("eraseWorkspace shreds the workspace's records and occurrences and reports the counts", async () => {
    const s = createOccurrenceStore(() => NOW);
    const rule = ruleFor(WS_A, "rule:a1");
    s.registerRule(rule);
    await s.observe(obs(rule, { conditionMet: true, sourceObservationIdentity: 1 }));
    expect(s.listRecords(WS_A)).toHaveLength(1);
    expect(s.listOccurrences(rule.ruleReference)).toHaveLength(1);

    const receipt = s.eraseWorkspace(WS_A, 5);
    expect(receipt).toEqual({ occurrences: 1, records: 1 });
    expect(s.listRecords(WS_A)).toHaveLength(0);
    expect(s.listOccurrences(rule.ruleReference)).toHaveLength(0);
  });

  it("a late observation after erasure is ignored and regenerates nothing", async () => {
    const s = createOccurrenceStore(() => NOW);
    const rule = ruleFor(WS_A, "rule:a1");
    s.registerRule(rule);
    await s.observe(obs(rule, { conditionMet: true, sourceObservationIdentity: 1 }));
    s.eraseWorkspace(WS_A, 5);

    // a late worker/webhook replay for the erased rule must not resurrect state.
    const late = await s.observe(obs(rule, { conditionMet: true, sourceObservationIdentity: 2 }));
    expect(late).toEqual({ kind: "ignored", reason: "unknown_rule" });
    expect(s.listRecords(WS_A)).toHaveLength(0);
    expect(s.listOccurrences(rule.ruleReference)).toHaveLength(0);
  });

  it("a restored rule registration at an old epoch is suppressed so nothing regenerates", async () => {
    const s = createOccurrenceStore(() => NOW); // write epoch defaults to 1
    const rule = ruleFor(WS_A, "rule:a1");
    s.registerRule(rule);
    await s.observe(obs(rule, { conditionMet: true, sourceObservationIdentity: 1 }));
    s.eraseWorkspace(WS_A, 5); // fence 5 > default write epoch 1

    // a backup restore replays the registration + observation at the old epoch.
    s.registerRule(rule);
    const replay = await s.observe(obs(rule, { conditionMet: true, sourceObservationIdentity: 3 }));
    expect(replay.kind).toBe("ignored");
    expect(s.listRecords(WS_A)).toHaveLength(0);
    expect(s.listOccurrences(rule.ruleReference)).toHaveLength(0);
  });

  it("erasing one workspace leaves another workspace's delivery state intact", async () => {
    const s = createOccurrenceStore(() => NOW);
    const a = ruleFor(WS_A, "rule:a1");
    const b = ruleFor(WS_B, "rule:b1");
    s.registerRule(a);
    s.registerRule(b);
    await s.observe(obs(a, { conditionMet: true, sourceObservationIdentity: 1 }));
    await s.observe(obs(b, { conditionMet: true, sourceObservationIdentity: 1 }));

    s.eraseWorkspace(WS_A, 5);
    expect(s.listRecords(WS_A)).toHaveLength(0);
    expect(s.listRecords(WS_B)).toHaveLength(1);
    expect(s.listOccurrences(b.ruleReference)).toHaveLength(1);
  });
});
