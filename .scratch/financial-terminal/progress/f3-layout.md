# F3 — Workspace layout module (progress)

Status: DONE (unit-green, typecheck-clean). Browser/perf specs written but INTEGRATION PENDING (need the route mounted by the main agent).

## Files created (exact paths)

Domain + server logic (pure, unit-tested — priority):
- `src/modules/terminal-view/layout/contracts.ts` — model + branded command/outcome types, grid bound constants.
- `src/modules/terminal-view/layout/layout-domain.ts` — `applyLayoutChange`, `initialWorkspaceLayout`, `DEFAULT_PANEL_WIDTHS`.
- `src/modules/terminal-view/layout/layout-service.ts` — `createLayoutService` (guest draft vs workspace persistence, adopt, A/B isolation).
- `src/modules/terminal-view/layout/layout-presenter.ts` — `presentLayout`, `widgetName`, `widgetLabels`.

Client component:
- `src/modules/terminal-view/layout/workspace-layout.tsx` — `WorkspaceLayout` (`"use client"`).
- `src/modules/terminal-view/layout/workspace-layout.module.css`.

Tests:
- `tests/layout-domain.test.ts` — 13 unit oracles (reducer + service). PASSING.
- `tests/layout-presenter.test.ts` — 4 unit oracles (accessible summary/labels). PASSING.
- `tests/browser/workspace-layout.spec.ts` — Playwright + axe. INTEGRATION PENDING.
- `tests/performance/layout-performance.spec.ts` — §11.2 p95 budgets. INTEGRATION PENDING.

## Public shapes

```ts
// contracts.ts
type WorkspaceLayoutModel = { revision: number; panels: { left; right }; widgets: LayoutWidget[] };
type LayoutWidget = { widgetId: string; geometry: { x; y; w; h }; panes: number };
type ChangeWorkspaceLayoutCommand = ChangeWorkspaceLayout & { operation:
    | { type: "move"; widgetId; x; y }
    | { type: "resize"; widgetId; w; h }
    | { type: "divider"; left; right }
    | { type: "split"; widgetId; panes } };
type LayoutOutcome = LayoutReceipt | LayoutConflict | LayoutRejected;  // all kind:"LayoutCommandOutcome"

// layout-domain.ts
applyLayoutChange(current: WorkspaceLayoutModel, command: ChangeWorkspaceLayoutCommand, control: MutationControl): LayoutOutcome
initialWorkspaceLayout(widgets: readonly LayoutWidget[]): WorkspaceLayoutModel

// layout-service.ts
createLayoutService({ seed: readonly LayoutWidget[]; resolveViewer: (SessionProof) => ViewerContext }): {
  open(sessionProof): WorkspaceLayoutModel,
  changeLayout(command, control, sessionProof): LayoutOutcome,
  adopt(draft: WorkspaceLayoutModel, sessionProof): LayoutOutcome,
}

// layout-presenter.ts
presentLayout(layout): { revision; widgets: WidgetView[]; accessibleSummary; announcement }

// workspace-layout.tsx
<WorkspaceLayout initial={WorkspaceLayoutModel} idPrefix?={string} />
```

## Semantics locked by the oracles (AT-03 / UF-04)
- Valid op → `applied`, revision +1, geometry changed & clamped to 12×24 grid.
- same key + same payload → existing `applied` receipt, revision NOT re-bumped.
- same key + different payload → `conflict`, layout unchanged.
- stale `expectedRevision` → `rejected` (reason `stale_revision`) carrying current revision.
- Guest `changeLayout` never persists; `open` for a guest always returns the pristine seed.
- Workspace `changeLayout` persists keyed by `workspaceReference`; `open` restores it (reload).
- User A vs B isolated by workspace key.
- `adopt(draft, workspaceProof)` merges draft into the server workspace (revision +1); `adopt` by a guest → `rejected`.

## Unit test result
`npx vitest run tests/layout-domain.test.ts tests/layout-presenter.test.ts` → **2 files, 17 tests, all passing.**
Full-repo `npx tsc --noEmit` → **0 errors** (nothing originates in layout/** or my tests).

## Idempotency ledger caveat (read before wiring persistence)
`applyLayoutChange` stores its per-key receipt ledger on the returned `WorkspaceLayoutModel` via a `WeakMap` (module-private, in `layout-domain.ts`). The service persists the returned model object, so the ledger survives as long as that object is the live server layout. If the main agent serializes the layout to a DB and rehydrates a NEW object, the idempotency ledger is lost (a replayed same-key command would re-apply). For the MVP in-memory store this is fine. Upgrade path when a DB lands: persist `{ idempotencyKey → payloadHash, revision }` alongside the layout row and pass it back in — do NOT rely on object identity across a serialize boundary.

## EXACT integration steps for the main agent

1. **Wire `TerminalView.changeLayout`** (in the composition/module that implements the `TerminalView` interface): construct one `createLayoutService({ seed, resolveViewer })` per server instance.
   - `seed`: the default widget set (the browser/perf specs assume two widgets — `chart` at x0 y0 w6 h8, `watchlist` at x6 y0 w3 h8; align the real seed or update the specs' literals).
   - `resolveViewer`: pass `Identity.resolve` (the shared `Identity.resolve(sessionProof): ViewerContext`). The layout module deliberately does NOT import Identity — inject it here.
   - `TerminalView.changeLayout(command, control, sessionProof)` → `service.changeLayout(command as ChangeWorkspaceLayoutCommand, control, sessionProof)`. The returned `LayoutOutcome` already satisfies `LayoutCommandOutcome`.
   - `TerminalView.open`'s layout panel → `service.open(sessionProof)` for the initial board.

2. **Mount `<WorkspaceLayout initial={service.open(proof)} />`** at the logged-in terminal workspace route (center column of the shell, analogous to how `<ChartWorkspace/>` is mounted in `guest-terminal-shell.tsx`). Component is `"use client"`; pass the server-read `WorkspaceLayoutModel` as `initial`.
   - For guest surface: mount with a seed model; the component edits locally only (guest draft) — no server round-trip needed for MVP.
   - Post-login adoption: call `service.adopt(guestDraftModel, sessionProof)` when the user explicitly adopts; expose that draft from the client (e.g. localStorage) — the browser-local persistence of the guest draft is a client concern, not in this module.

3. **Browser lane**: add `tests/browser/workspace-layout.spec.ts` to the browser project(s) in the playwright browser config (same lane as `tests/browser/guest-*.spec.ts`). Confirm/replace the `ROUTE = "/workspace"` constant with the real mounted route, and ensure the seed matches the two-widget literals. (I did NOT edit any playwright config — that is yours.)

4. **Performance lane**: add `tests/performance/layout-performance.spec.ts` to the perf config with `desktop-1366` + `mobile-360` projects (same shape as `chart-performance.spec.ts`). Align `baseURL`/`ROUTE` constants with the port your perf webServer serves the mounted route on.

5. **Barrel/exports**: no barrel exists for `terminal-view/layout/**` yet. If composition imports through a barrel, add `export * from "./layout/layout-service"` etc.; otherwise import the named symbols directly.

## data-* observability seams (for the browser/perf specs)
- `[data-role="workspace-layout"]` — section, `data-revision`.
- `[data-role="layout-summary"]` — aria-live, `data-revision`, `data-widget-count`.
- `[data-role="layout-widget"][data-widget-id=...]` — `data-x/y/w/h/panes`.
- `[data-role="layout-announcement"]` — aria-live=assertive.
- Move/resize/split controls: `button[aria-label="차트 오른쪽으로 이동"]`, `"차트 너비 늘리기"`, `"차트 분할"`, `"좌측 패널 넓히기"`, etc.
