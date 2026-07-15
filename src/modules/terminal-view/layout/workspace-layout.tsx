"use client";

import { useRef, useState } from "react";

import { brandReference } from "../../../shared/contracts/brands";
import type { MutationControl } from "../../../shared/contracts/mutation-control";

import { applyLayoutChange } from "./layout-domain";
import type { ChangeWorkspaceLayoutCommand, WorkspaceLayoutModel } from "./contracts";
import { presentLayout, widgetName } from "./layout-presenter";
import styles from "./workspace-layout.module.css";

/**
 * Self-contained interactive workspace grid. Keyboard/touch-equivalent move &
 * resize controls (WS-03: buttons with aria labels, not drag-only), aria-live
 * announcements + focus return (WS-06), single column + internal scroll (WS-04),
 * 44px touch targets, latest-revision-only paint. Korean labels.
 *
 * ponytail: reuses the pure `applyLayoutChange` reducer for local edits — the same
 * oracle the server runs, so client and server geometry cannot diverge. Server
 * confirmation wiring is the main agent's job (see progress notes).
 */
export function WorkspaceLayout({ initial, idPrefix = "wl", persistUrl }: Readonly<{
  initial: WorkspaceLayoutModel;
  idPrefix?: string;
  /** When set (logged-in workspace), each applied change is persisted server-side so a reload restores it. */
  persistUrl?: string;
}>) {
  const [layout, setLayout] = useState<WorkspaceLayoutModel>(initial);
  const [announcement, setAnnouncement] = useState("워크스페이스 레이아웃 준비 완료");
  const revisionRef = useRef(initial.revision);
  const view = presentLayout(layout);

  function dispatch(op: ChangeWorkspaceLayoutCommand["operation"], focusId: string) {
    const command: ChangeWorkspaceLayoutCommand = { kind: "ChangeWorkspaceLayout", operation: op };
    const control: MutationControl = {
      idempotencyKey: `${idPrefix}-${layout.revision}-${JSON.stringify(op)}`,
      expectedRevision: brandReference<string, "Revision">(String(layout.revision)),
    };
    const outcome = applyLayoutChange(layout, command, control);
    // Latest-revision-only paint: never regress to an older board.
    if (outcome.status !== "applied" || outcome.layout.revision < revisionRef.current) {
      setAnnouncement("변경이 적용되지 않았습니다. 저장되지 않음.");
      return;
    }
    revisionRef.current = outcome.layout.revision;
    setLayout(outcome.layout);
    setAnnouncement(presentLayout(outcome.layout).announcement);
    // Optimistic paint above; persist best-effort so a reload restores it (never blocks the paint).
    if (persistUrl !== undefined) {
      void fetch(persistUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: op, expectedRevision: String(layout.revision), idempotencyKey: control.idempotencyKey }),
      }).catch(() => setAnnouncement("변경을 저장하지 못했습니다."));
    }
    // Focus return: keep the acted-on control focused after the paint (WS-06).
    requestAnimationFrame(() => document.getElementById(focusId)?.focus());
  }

  return (
    <section
      className={styles.workspace}
      aria-label="워크스페이스 레이아웃 편집기"
      data-role="workspace-layout"
      data-revision={String(layout.revision)}
    >
      <p
        className={styles.summary}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-role="layout-summary"
        data-revision={String(layout.revision)}
        data-widget-count={String(view.widgets.length)}
      >
        {view.accessibleSummary}
      </p>

      <div className={styles.panels} role="group" aria-label="패널 divider">
        <button
          type="button"
          id={`${idPrefix}-panel-left-wider`}
          className={styles.control}
          aria-label="좌측 패널 넓히기"
          onClick={() => dispatch({ type: "divider", left: layout.panels.left + 1, right: layout.panels.right }, `${idPrefix}-panel-left-wider`)}
        >
          좌측 +
        </button>
        <button
          type="button"
          id={`${idPrefix}-panel-left-narrower`}
          className={styles.control}
          aria-label="좌측 패널 좁히기"
          onClick={() => dispatch({ type: "divider", left: Math.max(0, layout.panels.left - 1), right: layout.panels.right }, `${idPrefix}-panel-left-narrower`)}
        >
          좌측 −
        </button>
      </div>

      <ul className={styles.grid} aria-label="위젯 목록">
        {view.widgets.map((w) => {
          const g = w.geometry;
          const moveDown = `${idPrefix}-${w.widgetId}-move-down`;
          const moveRight = `${idPrefix}-${w.widgetId}-move-right`;
          const moveLeft = `${idPrefix}-${w.widgetId}-move-left`;
          const moveUp = `${idPrefix}-${w.widgetId}-move-up`;
          const wider = `${idPrefix}-${w.widgetId}-wider`;
          const taller = `${idPrefix}-${w.widgetId}-taller`;
          const splitId = `${idPrefix}-${w.widgetId}-split`;
          return (
            <li
              key={w.widgetId}
              className={styles.widget}
              data-role="layout-widget"
              data-widget-id={w.widgetId}
              data-x={String(g.x)}
              data-y={String(g.y)}
              data-w={String(g.w)}
              data-h={String(g.h)}
              data-panes={String(w.panes)}
            >
              <h3 className={styles.widgetTitle}>{widgetName(w.widgetId)}</h3>
              <p className={styles.widgetLabel} data-role="widget-label">{w.label}</p>
              <div className={styles.controls} role="group" aria-label={`${w.name} 이동·크기 조절`}>
                <button type="button" id={moveLeft} className={styles.control} aria-label={`${w.name} 왼쪽으로 이동`}
                  onClick={() => dispatch({ type: "move", widgetId: w.widgetId, x: g.x - 1, y: g.y }, moveLeft)}>←</button>
                <button type="button" id={moveRight} className={styles.control} aria-label={`${w.name} 오른쪽으로 이동`}
                  onClick={() => dispatch({ type: "move", widgetId: w.widgetId, x: g.x + 1, y: g.y }, moveRight)}>→</button>
                <button type="button" id={moveUp} className={styles.control} aria-label={`${w.name} 위로 이동`}
                  onClick={() => dispatch({ type: "move", widgetId: w.widgetId, x: g.x, y: g.y - 1 }, moveUp)}>↑</button>
                <button type="button" id={moveDown} className={styles.control} aria-label={`${w.name} 아래로 이동`}
                  onClick={() => dispatch({ type: "move", widgetId: w.widgetId, x: g.x, y: g.y + 1 }, moveDown)}>↓</button>
                <button type="button" id={wider} className={styles.control} aria-label={`${w.name} 너비 늘리기`}
                  onClick={() => dispatch({ type: "resize", widgetId: w.widgetId, w: g.w + 1, h: g.h }, wider)}>넓게</button>
                <button type="button" id={taller} className={styles.control} aria-label={`${w.name} 높이 늘리기`}
                  onClick={() => dispatch({ type: "resize", widgetId: w.widgetId, w: g.w, h: g.h + 1 }, taller)}>높게</button>
                <button type="button" id={splitId} className={styles.control} aria-label={`${w.name} 분할`}
                  onClick={() => dispatch({ type: "split", widgetId: w.widgetId, panes: w.panes + 1 }, splitId)}>분할</button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className={styles.srStatus} role="status" aria-live="assertive" aria-atomic="true" data-role="layout-announcement">
        {announcement}
      </div>
    </section>
  );
}
