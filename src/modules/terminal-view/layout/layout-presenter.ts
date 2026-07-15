import type { LayoutWidget, WorkspaceLayoutModel } from "./contracts";

/** Korean display names for known widgets; unknown ids fall back to the id. */
export const widgetLabels: Readonly<Record<string, string>> = {
  chart: "차트",
  watchlist: "관심종목",
  filings: "공시",
  news: "주요 뉴스",
  paper: "Paper Trading",
  ai: "AI Assistant",
};

export function widgetName(widgetId: string): string {
  return widgetLabels[widgetId] ?? widgetId;
}

export type WidgetView = Readonly<{
  widgetId: string;
  name: string;
  /** Color-free spoken position: names widget + grid cell + size (WS-06). */
  label: string;
  geometry: LayoutWidget["geometry"];
  panes: number;
}>;

export type LayoutView = Readonly<{
  revision: number;
  widgets: readonly WidgetView[];
  /** aria-live status describing the board without relying on color. */
  accessibleSummary: string;
  /** Announcement string to push into an aria-live region after a change. */
  announcement: string;
}>;

function labelFor(widget: LayoutWidget): string {
  const name = widgetName(widget.widgetId);
  const { x, y, w, h } = widget.geometry;
  // 1-index the grid for humans; describe size in words so it never needs color.
  const paneNote = widget.panes > 1 ? `, ${widget.panes}분할` : "";
  return `${name}: 열 ${x + 1}, 행 ${y + 1}, 너비 ${w}, 높이 ${h}${paneNote}`;
}

export function presentLayout(layout: WorkspaceLayoutModel): LayoutView {
  const widgets = layout.widgets.map((widget) => ({
    widgetId: widget.widgetId,
    name: widgetName(widget.widgetId),
    label: labelFor(widget),
    geometry: widget.geometry,
    panes: widget.panes,
  }));
  const summary = `리비전 ${layout.revision}, 위젯 ${widgets.length}개, 좌 ${layout.panels.left}열 · 우 ${layout.panels.right}열`;
  return {
    revision: layout.revision,
    widgets,
    accessibleSummary: summary,
    announcement: `레이아웃 갱신됨 · ${summary}`,
  };
}
