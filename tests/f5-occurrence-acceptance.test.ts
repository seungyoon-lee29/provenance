/**
 * Blind acceptance tests for the F5 Alert Occurrence exactly-once engine.
 * Source of truth: spec §11 / CONTEXT "Alert Occurrence" / AT-10.
 * HARD RULE: this file does NOT read occurrence-engine.ts body.
 */

import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { createOccurrenceStore } from "../src/modules/notification-center/occurrence-engine";
import type {
  AlertObservation,
  AlertRule,
  AlertRuleReference,
} from "../src/modules/notification-center/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = "2026-07-16T00:00:00.000Z";
const T1 = "2026-07-16T00:01:00.000Z";

const RULE_REF = brandReference<string, "AlertRuleReference">("rule:test-rule");
const WORKSPACE = brandReference<string, "WorkspaceReference">("workspace:ws1");

const RULE: AlertRule = {
  ruleReference: RULE_REF,
  workspaceReference: WORKSPACE,
  conditionRevision: "rev-1",
};

function makeStore() {
  const s = createOccurrenceStore(() => T0);
  s.registerRule(RULE);
  return s;
}

function obs(
  overrides: Partial<AlertObservation> &
    Pick<AlertObservation, "conditionMet" | "sourceObservationIdentity">,
): AlertObservation {
  return {
    ruleReference: RULE_REF,
    conditionRevision: "rev-1",
    asOf: T0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Invariant 1 — false→true creates exactly one occurrence AND one record
//               occurrence.causeId === record.causeId
// ---------------------------------------------------------------------------

describe("Invariant 1: false→true creates exactly-one occurrence and record", () => {
  it("result kind is 'transition'", async () => {
    const s = makeStore();
    const r = await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    expect(r.kind).toBe("transition");
  });

  it("exactly one occurrence is stored after first true", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    expect(s.listOccurrences(RULE_REF)).toHaveLength(1);
  });

  it("exactly one NotificationRecord is stored after first true", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    expect(s.listRecords(WORKSPACE)).toHaveLength(1);
  });

  it("occurrence.causeId === record.causeId (delivery-cause linkage)", async () => {
    const s = makeStore();
    const r = await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    if (r.kind !== "transition") throw new Error(`expected transition, got ${r.kind}`);
    expect(r.occurrence.causeId).toBe(r.record.causeId);
    expect(typeof r.occurrence.causeId).toBe("string");
    expect(r.occurrence.causeId.length).toBeGreaterThan(0);
  });

  it("occurrence carries the rule and workspace references", async () => {
    const s = makeStore();
    const r = await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    if (r.kind !== "transition") throw new Error(`expected transition, got ${r.kind}`);
    expect(r.occurrence.ruleReference).toBe(RULE_REF);
    expect(r.occurrence.workspaceReference).toBe(WORKSPACE);
    expect(r.occurrence.conditionRevision).toBe("rev-1");
    expect(r.occurrence.sourceObservationIdentity).toBe(1);
    expect(r.occurrence.occurredAt).toBe(T0);
  });

  it("record carries workspace reference, is unread and undismissed initially", async () => {
    const s = makeStore();
    const r = await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    if (r.kind !== "transition") throw new Error(`expected transition, got ${r.kind}`);
    expect(r.record.workspaceReference).toBe(WORKSPACE);
    expect(r.record.occurrenceReference).toBe(r.occurrence.occurrenceReference);
    expect(r.record.read).toBe(false);
    expect(r.record.dismissed).toBe(false);
    expect(r.record.triggeredAt).toBe(T0);
    expect(r.record.createdAt).toBe(T0);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 — sourceObservationIdentity is the watermark; stale = ignored
// ---------------------------------------------------------------------------

describe("Invariant 2: watermark — stale observations are ignored and do not roll back", () => {
  it("an observation at a lower identity than the watermark is ignored with stale_observation", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 10 }));
    const late = await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 5 }));
    expect(late).toEqual({ kind: "ignored", reason: "stale_observation" });
  });

  it("a stale observation does NOT create a new occurrence or record", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 10 }));
    await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 5 }));
    expect(s.listOccurrences(RULE_REF)).toHaveLength(1);
    expect(s.listRecords(WORKSPACE)).toHaveLength(1);
  });

  it("watermark is not rolled back — re-send at the same identity as watermark is still stale", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 10 }));
    // false at 5 is stale → ignored
    await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 5 }));
    // now another true at 10 — same identity as applied → must still be ignored
    const replay = await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 10 }));
    expect(replay).toEqual({ kind: "ignored", reason: "stale_observation" });
    expect(s.listOccurrences(RULE_REF)).toHaveLength(1);
  });

  it("observation at identity equal to watermark (exact replay) is ignored", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 7 }));
    const replay = await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 7 }));
    expect(replay).toEqual({ kind: "ignored", reason: "stale_observation" });
  });

  it("a still-false observation at a fresh identity emits no_transition:still_false", async () => {
    const s = makeStore();
    const r = await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 1 }));
    expect(r).toEqual({ kind: "no_transition", reason: "still_false" });
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 — AT-10 core: 100 concurrent observations → exactly one
// ---------------------------------------------------------------------------

describe("Invariant 3 (AT-10): 100 concurrent same-transition observations → exactly one", () => {
  it("exactly one result has kind 'transition'", async () => {
    const s = makeStore();
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 })),
      ),
    );
    const transitions = results.filter((r) => r.kind === "transition");
    expect(transitions).toHaveLength(1);
  });

  it("exactly one occurrence is stored after 100 concurrent calls", async () => {
    const s = makeStore();
    await Promise.all(
      Array.from({ length: 100 }, () =>
        s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 })),
      ),
    );
    expect(s.listOccurrences(RULE_REF)).toHaveLength(1);
  });

  it("exactly one record is stored after 100 concurrent calls", async () => {
    const s = makeStore();
    await Promise.all(
      Array.from({ length: 100 }, () =>
        s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 })),
      ),
    );
    expect(s.listRecords(WORKSPACE)).toHaveLength(1);
  });

  it("the 99 non-winning results are all ignored with stale_observation", async () => {
    const s = makeStore();
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 })),
      ),
    );
    const ignored = results.filter(
      (r) => r.kind === "ignored" && r.reason === "stale_observation",
    );
    expect(ignored).toHaveLength(99);
  });
});

// ---------------------------------------------------------------------------
// Invariant 4 — sustained true (true→true) → no_transition:still_true
// ---------------------------------------------------------------------------

describe("Invariant 4: sustained true does not create a new occurrence", () => {
  it("second true after first true returns no_transition:still_true", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    const r = await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 2 }));
    expect(r).toEqual({ kind: "no_transition", reason: "still_true" });
  });

  it("occurrence count stays at 1 after a second true", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 2 }));
    expect(s.listOccurrences(RULE_REF)).toHaveLength(1);
  });

  it("record count stays at 1 after a second true", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 2 }));
    expect(s.listRecords(WORKSPACE)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Invariant 5 — false→true→false→true yields two distinct occurrences
//               transitionSequence 1 then 2, distinct causeIds
// ---------------------------------------------------------------------------

describe("Invariant 5: two full cycles yield two distinct occurrences", () => {
  it("second cycle produces a new transition result", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 2 }));
    const r = await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 3 }));
    expect(r.kind).toBe("transition");
  });

  it("exactly two occurrences are stored after two complete cycles", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 2 }));
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 3 }));
    expect(s.listOccurrences(RULE_REF)).toHaveLength(2);
  });

  it("occurrences have transitionSequence 1 and 2 in order", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 2 }));
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 3 }));
    const all = s.listOccurrences(RULE_REF);
    expect(all.map((o) => o.transitionSequence)).toEqual([1, 2]);
  });

  it("the two occurrences have distinct causeIds", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 2 }));
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 3 }));
    const all = s.listOccurrences(RULE_REF);
    expect(all[0]!.causeId).not.toBe(all[1]!.causeId);
    expect(new Set(all.map((o) => o.causeId)).size).toBe(2);
  });

  it("the two occurrences have distinct occurrenceReferences", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 2 }));
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 3 }));
    const all = s.listOccurrences(RULE_REF);
    expect(all[0]!.occurrenceReference).not.toBe(all[1]!.occurrenceReference);
  });

  it("exactly two records are stored after two cycles", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    await s.observe(obs({ conditionMet: false, sourceObservationIdentity: 2 }));
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 3 }));
    expect(s.listRecords(WORKSPACE)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Invariant 6 — unknown rule → ignored:unknown_rule, nothing stored
// ---------------------------------------------------------------------------

describe("Invariant 6: unregistered rule is ignored", () => {
  it("returns ignored:unknown_rule for an unregistered rule", async () => {
    const s = makeStore();
    const unknownRef = brandReference<string, "AlertRuleReference">("rule:ghost");
    const r = await s.observe({
      ruleReference: unknownRef,
      conditionRevision: "rev-1",
      conditionMet: true,
      sourceObservationIdentity: 1,
      asOf: T0,
    });
    expect(r).toEqual({ kind: "ignored", reason: "unknown_rule" });
  });

  it("unknown rule creates no occurrences for known rule", async () => {
    const s = makeStore();
    const unknownRef = brandReference<string, "AlertRuleReference">("rule:ghost");
    await s.observe({
      ruleReference: unknownRef,
      conditionRevision: "rev-1",
      conditionMet: true,
      sourceObservationIdentity: 1,
      asOf: T0,
    });
    expect(s.listOccurrences(RULE_REF)).toHaveLength(0);
  });

  it("unknown rule creates no records for the workspace", async () => {
    const s = makeStore();
    const unknownRef = brandReference<string, "AlertRuleReference">("rule:ghost");
    await s.observe({
      ruleReference: unknownRef,
      conditionRevision: "rev-1",
      conditionMet: true,
      sourceObservationIdentity: 1,
      asOf: T0,
    });
    expect(s.listRecords(WORKSPACE)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Invariant 7 — new conditionRevision starts as false; first true fires fresh
// ---------------------------------------------------------------------------

describe("Invariant 7: new conditionRevision starts effectively false", () => {
  it("first true under a new revision fires a fresh transition even if previous was true", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    // Same rule, new revision — acts as a fresh false baseline.
    const r = await s.observe({
      ruleReference: RULE_REF,
      conditionRevision: "rev-2",
      conditionMet: true,
      sourceObservationIdentity: 2,
      asOf: T0,
    });
    expect(r.kind).toBe("transition");
  });

  it("new revision transition adds a second occurrence", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    await s.observe({
      ruleReference: RULE_REF,
      conditionRevision: "rev-2",
      conditionMet: true,
      sourceObservationIdentity: 2,
      asOf: T0,
    });
    expect(s.listOccurrences(RULE_REF)).toHaveLength(2);
  });

  it("new revision occurrence carries the new conditionRevision string", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    const r = await s.observe({
      ruleReference: RULE_REF,
      conditionRevision: "rev-2",
      conditionMet: true,
      sourceObservationIdentity: 2,
      asOf: T0,
    });
    if (r.kind !== "transition") throw new Error(`expected transition, got ${r.kind}`);
    expect(r.occurrence.conditionRevision).toBe("rev-2");
  });

  it("new revision without prior true also fires (baseline is always false for fresh revision)", async () => {
    const s = makeStore();
    // Register a second rule with rev-2 only (never seen rev-1 for it)
    const rule2: AlertRule = {
      ruleReference: brandReference<string, "AlertRuleReference">("rule:fresh-rev"),
      workspaceReference: WORKSPACE,
      conditionRevision: "rev-2",
    };
    s.registerRule(rule2);
    const r = await s.observe({
      ruleReference: rule2.ruleReference,
      conditionRevision: "rev-2",
      conditionMet: true,
      sourceObservationIdentity: 1,
      asOf: T0,
    });
    expect(r.kind).toBe("transition");
    expect(s.listOccurrences(rule2.ruleReference)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: listRecords is workspace-scoped, listOccurrences is rule-scoped
// ---------------------------------------------------------------------------

describe("Scoping: listOccurrences is per-rule, listRecords is per-workspace", () => {
  it("two rules in the same workspace each accumulate independent occurrences", async () => {
    const s = createOccurrenceStore(() => T0);
    const ruleA: AlertRule = {
      ruleReference: brandReference<string, "AlertRuleReference">("rule:A"),
      workspaceReference: WORKSPACE,
      conditionRevision: "rev-1",
    };
    const ruleB: AlertRule = {
      ruleReference: brandReference<string, "AlertRuleReference">("rule:B"),
      workspaceReference: WORKSPACE,
      conditionRevision: "rev-1",
    };
    s.registerRule(ruleA);
    s.registerRule(ruleB);

    await s.observe({ ruleReference: ruleA.ruleReference, conditionRevision: "rev-1", conditionMet: true, sourceObservationIdentity: 1, asOf: T0 });
    await s.observe({ ruleReference: ruleB.ruleReference, conditionRevision: "rev-1", conditionMet: true, sourceObservationIdentity: 1, asOf: T0 });

    expect(s.listOccurrences(ruleA.ruleReference)).toHaveLength(1);
    expect(s.listOccurrences(ruleB.ruleReference)).toHaveLength(1);
    // Both records show up under the shared workspace
    expect(s.listRecords(WORKSPACE)).toHaveLength(2);
  });

  it("listRecords for a different workspace returns nothing", async () => {
    const s = makeStore();
    await s.observe(obs({ conditionMet: true, sourceObservationIdentity: 1 }));
    const other = brandReference<string, "WorkspaceReference">("workspace:other");
    expect(s.listRecords(other)).toHaveLength(0);
  });
});
