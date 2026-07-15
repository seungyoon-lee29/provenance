import { brandReference } from "../../../shared/contracts/brands";
import type { MutationControl } from "../../../shared/contracts/mutation-control";

import {
  LAYOUT_GRID_COLUMNS,
  LAYOUT_GRID_ROWS,
  LAYOUT_MIN_WIDGET_H,
  LAYOUT_MIN_WIDGET_W,
} from "./contracts";
import type {
  ChangeWorkspaceLayoutCommand,
  LayoutOutcome,
  LayoutWidget,
  WidgetGeometry,
  WorkspaceLayoutModel,
} from "./contracts";

export const DEFAULT_PANEL_WIDTHS = { left: 3, right: 3 } as const;

export function initialWorkspaceLayout(widgets: readonly LayoutWidget[]): WorkspaceLayoutModel {
  return { revision: 0, panels: { ...DEFAULT_PANEL_WIDTHS }, widgets: widgets.map((w) => ({ ...w })) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamp geometry to the grid so a widget never leaves the board. Width/height are
 * clamped first, then the origin is clamped against the (already-bounded) size so
 * x+w ≤ columns and y+h ≤ rows.
 * ponytail: the only knobs are the four LAYOUT_* bound constants in contracts.ts;
 * clamp logic itself is grid-size agnostic. Upgrade path: per-widget min-size or
 * collision packing — add a widget-kind → minima map, not new branches here.
 */
function clampGeometry(g: WidgetGeometry): WidgetGeometry {
  const w = clamp(g.w, LAYOUT_MIN_WIDGET_W, LAYOUT_GRID_COLUMNS);
  const h = clamp(g.h, LAYOUT_MIN_WIDGET_H, LAYOUT_GRID_ROWS);
  return {
    w,
    h,
    x: clamp(g.x, 0, LAYOUT_GRID_COLUMNS - w),
    y: clamp(g.y, 0, LAYOUT_GRID_ROWS - h),
  };
}

/** Canonical payload hash — stable JSON of the operation, so same op → same key. */
function payloadHash(command: ChangeWorkspaceLayoutCommand): string {
  const op = command.operation;
  switch (op.type) {
    case "move":
      return `move:${op.widgetId}:${op.x},${op.y}`;
    case "resize":
      return `resize:${op.widgetId}:${op.w}x${op.h}`;
    case "divider":
      return `divider:${op.left},${op.right}`;
    case "split":
      return `split:${op.widgetId}:${op.panes}`;
  }
}

// Idempotency ledger: last receipt per key, associated with a layout by object identity via a
// module-scoped WeakMap. This is deliberate server-side state kept OFF the WorkspaceLayoutModel so
// the idempotency table never rides the serialized model to the browser. Each service seeds its own
// fresh model objects, so the WeakMap keys never collide across service instances.
// ponytail: object-identity ledger is process-local; a real datastore must persist {key→hash,revision}
// alongside the row (survives serialize/rehydrate) — the reducer stays value-returning either way.
type Ledger = ReadonlyMap<string, Readonly<{ hash: string; layout: WorkspaceLayoutModel }>>;
const ledgers = new WeakMap<WorkspaceLayoutModel, Ledger>();

function ledgerOf(layout: WorkspaceLayoutModel): Ledger {
  return ledgers.get(layout) ?? new Map();
}

function withLedger(layout: WorkspaceLayoutModel, ledger: Ledger): WorkspaceLayoutModel {
  ledgers.set(layout, ledger);
  return layout;
}

function rev(n: number) {
  return brandReference<string, "Revision">(String(n));
}

function editWidgets(
  layout: WorkspaceLayoutModel,
  command: ChangeWorkspaceLayoutCommand,
): WorkspaceLayoutModel | "unknown_widget" {
  const op = command.operation;
  if (op.type === "divider") {
    // Left + right must leave at least one center column.
    const left = clamp(op.left, 0, LAYOUT_GRID_COLUMNS - 1);
    const right = clamp(op.right, 0, LAYOUT_GRID_COLUMNS - 1 - left);
    return { ...layout, panels: { left, right }, revision: layout.revision + 1 };
  }
  const idx = layout.widgets.findIndex((w) => w.widgetId === op.widgetId);
  if (idx < 0) return "unknown_widget";
  const target = layout.widgets[idx]!;
  let next: LayoutWidget;
  if (op.type === "move") next = { ...target, geometry: clampGeometry({ ...target.geometry, x: op.x, y: op.y }) };
  else if (op.type === "resize") next = { ...target, geometry: clampGeometry({ ...target.geometry, w: op.w, h: op.h }) };
  else next = { ...target, panes: clamp(op.panes, 1, 4) }; // ponytail: 4-pane cap; raise if quad-split proves too few
  const widgets = layout.widgets.map((w, i) => (i === idx ? next : w));
  return { ...layout, widgets, revision: layout.revision + 1 };
}

/**
 * Apply one layout change with revision + idempotency + conflict semantics (UF-04 / AT-03):
 * - same key + same payload  → existing receipt, no re-apply (revision unchanged)
 * - same key + different payload → side-effect-free conflict
 * - stale expectedRevision → rejected, carrying the current revision
 * - otherwise → applied, revision bumped, geometry actually changed & grid-clamped.
 */
export function applyLayoutChange(
  current: WorkspaceLayoutModel,
  command: ChangeWorkspaceLayoutCommand,
  control: MutationControl,
): LayoutOutcome {
  const ledger = ledgerOf(current);
  const hash = payloadHash(command);
  const prior = ledger.get(control.idempotencyKey);
  if (prior) {
    if (prior.hash === hash) {
      return {
        kind: "LayoutCommandOutcome",
        status: "applied",
        idempotencyKey: control.idempotencyKey,
        payloadHash: hash,
        revision: rev(prior.layout.revision),
        layout: prior.layout,
      };
    }
    return {
      kind: "LayoutCommandOutcome",
      status: "conflict",
      idempotencyKey: control.idempotencyKey,
      revision: rev(current.revision),
      layout: current,
    };
  }

  if (String(current.revision) !== String(control.expectedRevision)) {
    return { kind: "LayoutCommandOutcome", status: "rejected", reason: "stale_revision", revision: rev(current.revision), layout: current };
  }

  const edited = editWidgets(current, command);
  if (edited === "unknown_widget") {
    return { kind: "LayoutCommandOutcome", status: "rejected", reason: "unknown_widget", revision: rev(current.revision), layout: current };
  }

  const nextLedger = new Map(ledger).set(control.idempotencyKey, { hash, layout: edited });
  withLedger(edited, nextLedger);
  return {
    kind: "LayoutCommandOutcome",
    status: "applied",
    idempotencyKey: control.idempotencyKey,
    payloadHash: hash,
    revision: rev(edited.revision),
    layout: edited,
  };
}
