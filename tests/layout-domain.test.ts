import { describe, expect, it } from "vitest";

import {
  applyLayoutChange,
  initialWorkspaceLayout,
} from "../src/modules/terminal-view/layout/layout-domain";
import { createLayoutService } from "../src/modules/terminal-view/layout/layout-service";
import type { ChangeWorkspaceLayoutCommand } from "../src/modules/terminal-view/layout/contracts";
import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceReference } from "../src/shared/contracts/brands";
import type { MutationControl } from "../src/shared/contracts/mutation-control";
import type { SessionProof } from "../src/shared/contracts/module-interfaces";
import type { ViewerContext } from "../src/shared/contracts/viewer-context";

// Independent literal oracle: a fixed starting board. Two widgets, default panels.
// Handwritten here so tests never import the reducer to compute the expected value.
function board() {
  return initialWorkspaceLayout([
    { widgetId: "chart", geometry: { x: 0, y: 0, w: 6, h: 8 }, panes: 1 },
    { widgetId: "watchlist", geometry: { x: 6, y: 0, w: 3, h: 8 }, panes: 1 },
  ]);
}

function control(expected: number, key = "k1"): MutationControl {
  return { idempotencyKey: key, expectedRevision: brandReference<string, "Revision">(String(expected)) };
}

function move(widgetId: string, x: number, y: number): ChangeWorkspaceLayoutCommand {
  return { kind: "ChangeWorkspaceLayout", operation: { type: "move", widgetId, x, y } };
}
function resize(widgetId: string, w: number, h: number): ChangeWorkspaceLayoutCommand {
  return { kind: "ChangeWorkspaceLayout", operation: { type: "resize", widgetId, w, h } };
}
function divider(left: number, right: number): ChangeWorkspaceLayoutCommand {
  return { kind: "ChangeWorkspaceLayout", operation: { type: "divider", left, right } };
}
function split(widgetId: string, panes: number): ChangeWorkspaceLayoutCommand {
  return { kind: "ChangeWorkspaceLayout", operation: { type: "split", widgetId, panes } };
}

describe("applyLayoutChange geometry + revision", () => {
  it("moves a widget and bumps the revision to 1", () => {
    const out = applyLayoutChange(board(), move("chart", 2, 3), control(0));
    expect(out.status).toBe("applied");
    expect(out.revision).toBe("1");
    const chart = out.layout.widgets.find((w) => w.widgetId === "chart");
    expect(chart?.geometry).toEqual({ x: 2, y: 3, w: 6, h: 8 });
    // untouched widget keeps its geometry
    expect(out.layout.widgets.find((w) => w.widgetId === "watchlist")?.geometry).toEqual({ x: 6, y: 0, w: 3, h: 8 });
  });

  it("resizes a widget on both axes", () => {
    const out = applyLayoutChange(board(), resize("chart", 4, 5), control(0));
    expect(out.status).toBe("applied");
    expect(out.layout.widgets.find((w) => w.widgetId === "chart")?.geometry).toEqual({ x: 0, y: 0, w: 4, h: 5 });
  });

  it("resizes a panel divider", () => {
    const out = applyLayoutChange(board(), divider(2, 2), control(0));
    expect(out.status).toBe("applied");
    expect(out.layout.panels).toEqual({ left: 2, right: 2 });
  });

  it("splits a widget into panes", () => {
    const out = applyLayoutChange(board(), split("chart", 2), control(0));
    expect(out.status).toBe("applied");
    expect(out.layout.widgets.find((w) => w.widgetId === "chart")?.panes).toBe(2);
  });

  it("clamps move + resize to grid bounds (12x24)", () => {
    // x=20 clamped so x+w stays on the 12-col board; negative y clamped to 0.
    const moved = applyLayoutChange(board(), move("watchlist", 20, -4), control(0));
    const g = moved.layout.widgets.find((w) => w.widgetId === "watchlist")?.geometry;
    expect(g).toEqual({ x: 9, y: 0, w: 3, h: 8 }); // 12 - 3 = 9
    const big = applyLayoutChange(board(), resize("chart", 99, 99), control(0));
    expect(big.layout.widgets.find((w) => w.widgetId === "chart")?.geometry).toEqual({ x: 0, y: 0, w: 12, h: 24 });
  });
});

describe("idempotency + conflict + stale rejection", () => {
  it("same key + same payload returns the existing receipt (no double apply)", () => {
    const first = applyLayoutChange(board(), move("chart", 2, 3), control(0, "same"));
    const second = applyLayoutChange(first.layout, move("chart", 2, 3), control(0, "same"));
    expect(second.status).toBe("applied");
    // revision does NOT advance again; geometry is the already-applied one
    expect(second.revision).toBe(first.revision);
    expect(second.layout.widgets.find((w) => w.widgetId === "chart")?.geometry).toEqual({ x: 2, y: 3, w: 6, h: 8 });
  });

  it("same key + different payload is a side-effect-free conflict", () => {
    const first = applyLayoutChange(board(), move("chart", 2, 3), control(0, "dup"));
    const clash = applyLayoutChange(first.layout, move("chart", 5, 5), control(0, "dup"));
    expect(clash.status).toBe("conflict");
    // layout unchanged from the first apply
    expect(clash.layout.widgets.find((w) => w.widgetId === "chart")?.geometry).toEqual({ x: 2, y: 3, w: 6, h: 8 });
    expect(clash.revision).toBe(first.revision);
  });

  it("stale expectedRevision is rejected and carries the current revision", () => {
    const first = applyLayoutChange(board(), move("chart", 2, 3), control(0, "a"));
    // caller still thinks revision is 0, but server is at 1
    const stale = applyLayoutChange(first.layout, move("watchlist", 7, 1), control(0, "b"));
    expect(stale.status).toBe("rejected");
    if (stale.status === "rejected") expect(stale.reason).toBe("stale_revision");
    expect(stale.revision).toBe("1");
    // no geometry change
    expect(stale.layout.widgets.find((w) => w.widgetId === "watchlist")?.geometry).toEqual({ x: 6, y: 0, w: 3, h: 8 });
  });
});

// --- Service seam: guest draft vs server persistence, workspace isolation, adoption (UF-04 / AT-03) ---

const proof = (id: string): SessionProof => ({ kind: "SessionProof", ...({ ref: id } as object) }) as SessionProof;

function guest(requestId: string): ViewerContext {
  return { kind: "guest", requestId };
}
function workspace(ref: string): ViewerContext {
  return {
    kind: "workspace",
    requestId: `req-${ref}`,
    workspaceReference: brandReference<string, "WorkspaceReference">(ref) as WorkspaceReference,
    accountReference: brandReference<string, "AccountReference">(`acct-${ref}`),
    sessionReference: brandReference<string, "SessionReference">(`sess-${ref}`),
    sessionGeneration: brandReference<string, "SessionGeneration">("g1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("e1"),
    membershipRevision: brandReference<string, "MembershipRevision">("m1"),
  };
}

/** resolveViewer test double — routes a proof string to a viewer, no Identity import. */
function router(map: Readonly<Record<string, ViewerContext>>) {
  return (p: SessionProof): ViewerContext => {
    const key = (p as unknown as { ref: string }).ref;
    return map[key] ?? guest(key);
  };
}

function seed(): readonly { widgetId: string; geometry: { x: number; y: number; w: number; h: number }; panes: number }[] {
  return [
    { widgetId: "chart", geometry: { x: 0, y: 0, w: 6, h: 8 }, panes: 1 },
    { widgetId: "watchlist", geometry: { x: 6, y: 0, w: 3, h: 8 }, panes: 1 },
  ];
}

describe("layout service — guest draft vs server persistence", () => {
  it("guest changes never persist server-side (browser-local draft only)", () => {
    const svc = createLayoutService({ seed: seed(), resolveViewer: router({ g: guest("g") }) });
    const out = svc.changeLayout(move("chart", 2, 3), control(0, "g-move"), proof("g"));
    expect(out.status).toBe("applied");
    // A fresh server read for that guest is still the pristine seed (nothing stored).
    const reopened = svc.open(proof("g"));
    expect(reopened.revision).toBe(0);
    expect(reopened.widgets.find((w) => w.widgetId === "chart")?.geometry).toEqual({ x: 0, y: 0, w: 6, h: 8 });
  });

  it("workspace changes persist and reload restores them", () => {
    const svc = createLayoutService({ seed: seed(), resolveViewer: router({ A: workspace("A") }) });
    const out = svc.changeLayout(move("chart", 4, 1), control(0, "a1"), proof("A"));
    expect(out.status).toBe("applied");
    expect(out.revision).toBe("1");
    const reload = svc.open(proof("A"));
    expect(reload.revision).toBe(1);
    expect(reload.widgets.find((w) => w.widgetId === "chart")?.geometry).toEqual({ x: 4, y: 1, w: 6, h: 8 });
  });

  it("user A and user B layouts are isolated by workspace key", () => {
    const svc = createLayoutService({ seed: seed(), resolveViewer: router({ A: workspace("A"), B: workspace("B") }) });
    svc.changeLayout(move("chart", 2, 2), control(0, "a"), proof("A"));
    // B still expects revision 0 — its own board is untouched by A's write.
    const b = svc.changeLayout(move("chart", 8, 8), control(0, "b"), proof("B"));
    expect(b.status).toBe("applied");
    expect(svc.open(proof("A")).widgets.find((w) => w.widgetId === "chart")?.geometry).toEqual({ x: 2, y: 2, w: 6, h: 8 });
    expect(svc.open(proof("B")).widgets.find((w) => w.widgetId === "chart")?.geometry).toEqual({ x: 6, y: 8, w: 6, h: 8 });
  });

  it("explicit adopt merges a guest draft into the user workspace after login", () => {
    const svc = createLayoutService({ seed: seed(), resolveViewer: router({ g: guest("g"), A: workspace("A") }) });
    // Guest builds a draft locally, then submits it for adoption post-login.
    const draft = applyLayoutChange(svc.open(proof("g")), move("chart", 5, 5), control(0, "d"));
    const adopted = svc.adopt(draft.layout, proof("A"));
    expect(adopted.status).toBe("applied");
    // Server workspace now carries the merged geometry and a bumped revision.
    const reload = svc.open(proof("A"));
    expect(reload.widgets.find((w) => w.widgetId === "chart")?.geometry).toEqual({ x: 5, y: 5, w: 6, h: 8 });
    expect(reload.revision).toBeGreaterThan(0);
  });

  it("adopt by a guest viewer is rejected (no server workspace to merge into)", () => {
    const svc = createLayoutService({ seed: seed(), resolveViewer: router({ g: guest("g") }) });
    const draft = applyLayoutChange(svc.open(proof("g")), move("chart", 5, 5), control(0, "d"));
    const adopted = svc.adopt(draft.layout, proof("g"));
    expect(adopted.status).toBe("rejected");
  });
});
