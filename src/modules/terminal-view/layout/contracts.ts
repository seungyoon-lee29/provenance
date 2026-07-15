import type { ContractValue } from "@/shared/contracts/module-interfaces";
import type { ChangeWorkspaceLayout, LayoutCommandOutcome } from "@/shared/contracts/module-interfaces";
import type { Revision } from "@/shared/contracts/brands";

// ponytail: grid is a fixed 12-col × 24-row board. These bounds are the calibration
// knob — a denser board or a taller mobile column only changes these two constants,
// not the clamp logic. Tune here when the real desktop landmark grid is measured.
export const LAYOUT_GRID_COLUMNS = 12;
export const LAYOUT_GRID_ROWS = 24;
export const LAYOUT_MIN_WIDGET_W = 1;
export const LAYOUT_MIN_WIDGET_H = 1;

/** Panel divider widths as grid columns; left + right pin, center is the remainder. */
export type PanelWidths = Readonly<{ left: number; right: number }>;

export type WidgetGeometry = Readonly<{ x: number; y: number; w: number; h: number }>;

export type LayoutWidget = Readonly<{
  widgetId: string;
  geometry: WidgetGeometry;
  /** Panes a widget is split into (1 = single). Splitting a widget bumps this. */
  panes: number;
}>;

export type WorkspaceLayoutModel = Readonly<{
  revision: number;
  panels: PanelWidths;
  widgets: readonly LayoutWidget[];
}>;

/** Concrete branded command — extends the shared `ChangeWorkspaceLayout` contract value. */
export type ChangeWorkspaceLayoutCommand = ChangeWorkspaceLayout &
  Readonly<{
    operation:
      | Readonly<{ type: "move"; widgetId: string; x: number; y: number }>
      | Readonly<{ type: "resize"; widgetId: string; w: number; h: number }>
      | Readonly<{ type: "divider"; left: number; right: number }>
      | Readonly<{ type: "split"; widgetId: string; panes: number }>;
  }>;

export type LayoutReceipt = Readonly<{
  kind: "LayoutCommandOutcome";
  status: "applied";
  idempotencyKey: string;
  payloadHash: string;
  revision: Revision;
  layout: WorkspaceLayoutModel;
}>;

export type LayoutConflict = Readonly<{
  kind: "LayoutCommandOutcome";
  status: "conflict";
  idempotencyKey: string;
  /** Layout is unchanged — a same-key/different-payload replay is side-effect-free. */
  revision: Revision;
  layout: WorkspaceLayoutModel;
}>;

export type LayoutRejected = Readonly<{
  kind: "LayoutCommandOutcome";
  status: "rejected";
  reason: "stale_revision" | "unknown_widget";
  /** Current server revision, so the caller can rebase. */
  revision: Revision;
  layout: WorkspaceLayoutModel;
}>;

export type LayoutOutcome = LayoutReceipt | LayoutConflict | LayoutRejected;

// Structural check: LayoutOutcome is a concrete refinement of the shared brand.
const _outcomeIsContractValue: LayoutCommandOutcome = { kind: "LayoutCommandOutcome" } as LayoutOutcome;
void _outcomeIsContractValue;

export type { ContractValue };
