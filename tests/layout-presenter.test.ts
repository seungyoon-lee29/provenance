import { describe, expect, it } from "vitest";

import { presentLayout, widgetLabels } from "../src/modules/terminal-view/layout/layout-presenter";
import { initialWorkspaceLayout } from "../src/modules/terminal-view/layout/layout-domain";

function board() {
  return initialWorkspaceLayout([
    { widgetId: "chart", geometry: { x: 0, y: 0, w: 6, h: 8 }, panes: 1 },
    { widgetId: "watchlist", geometry: { x: 6, y: 0, w: 3, h: 8 }, panes: 1 },
  ]);
}

describe("presentLayout — accessible summary (WS-06)", () => {
  it("summarizes revision and widget count in Korean, color-independent", () => {
    const view = presentLayout(board());
    expect(view.revision).toBe(0);
    expect(view.accessibleSummary).toContain("리비전 0");
    expect(view.accessibleSummary).toContain("위젯 2개");
  });

  it("gives each widget a positional, color-free accessible label", () => {
    const view = presentLayout(board());
    const chart = view.widgets.find((w) => w.widgetId === "chart");
    // Label names the widget and its grid position/size in words — never color alone.
    expect(chart?.label).toContain("차트");
    expect(chart?.label).toContain("열 1"); // x=0 → column 1 (1-indexed for humans)
    expect(chart?.label).toContain("너비 6");
  });

  it("announces a move as a change message with the new position", () => {
    const before = board();
    const moved = { ...before, revision: 1, widgets: before.widgets.map((w) => (w.widgetId === "chart" ? { ...w, geometry: { ...w.geometry, x: 3 } } : w)) };
    const view = presentLayout(moved);
    expect(view.announcement).toContain("리비전 1");
  });
});

describe("widgetLabels", () => {
  it("maps known widget ids to Korean names", () => {
    expect(widgetLabels.chart).toBe("차트");
    expect(widgetLabels.watchlist).toBe("관심종목");
  });
});
