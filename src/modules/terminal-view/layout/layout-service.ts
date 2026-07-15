import { brandReference } from "../../../shared/contracts/brands";
import type { SessionProof } from "../../../shared/contracts/module-interfaces";
import type { MutationControl } from "../../../shared/contracts/mutation-control";
import type { ViewerContext } from "../../../shared/contracts/viewer-context";

import { applyLayoutChange, initialWorkspaceLayout } from "./layout-domain";
import type {
  ChangeWorkspaceLayoutCommand,
  LayoutOutcome,
  LayoutWidget,
  WorkspaceLayoutModel,
} from "./contracts";

type Seed = readonly LayoutWidget[];

/**
 * Server-side layout for TerminalView.changeLayout. Persistence is keyed by
 * workspace reference so user A's board never mixes with B's. A guest viewer has
 * NO server slot: its changes apply against a pristine seed and are discarded
 * (UF-04 — guest layout is a browser-local draft). Only `adopt`, called with a
 * logged-in workspace viewer, merges a submitted draft into the User Workspace.
 *
 * `resolveViewer` is the sole identity seam — inject a test double; this module
 * never imports a concrete Identity, only the shared ViewerContext/SessionProof.
 * ponytail: in-memory Map store, no DB. Swap the Map for a repository port when a
 * real datastore lands — the reducer and idempotency ledger are already pure.
 */
export function createLayoutService(options: Readonly<{
  seed: Seed;
  resolveViewer: (sessionProof: SessionProof) => ViewerContext;
}>) {
  const store = new Map<string, WorkspaceLayoutModel>();

  function freshSeed(): WorkspaceLayoutModel {
    return initialWorkspaceLayout(options.seed);
  }

  function serverLayout(workspaceKey: string): WorkspaceLayoutModel {
    const existing = store.get(workspaceKey);
    if (existing) return existing;
    const seeded = freshSeed();
    store.set(workspaceKey, seeded);
    return seeded;
  }

  function open(sessionProof: SessionProof): WorkspaceLayoutModel {
    const viewer = options.resolveViewer(sessionProof);
    // Guest reads always start from the pristine seed — nothing is persisted for them.
    if (viewer.kind === "guest") return freshSeed();
    return serverLayout(viewer.workspaceReference);
  }

  function changeLayout(
    command: ChangeWorkspaceLayoutCommand,
    control: MutationControl,
    sessionProof: SessionProof,
  ): LayoutOutcome {
    const viewer = options.resolveViewer(sessionProof);
    if (viewer.kind === "guest") {
      // Draft mutation: apply against a pristine seed and drop it — never stored.
      return applyLayoutChange(freshSeed(), command, control);
    }
    const outcome = applyLayoutChange(serverLayout(viewer.workspaceReference), command, control);
    if (outcome.status === "applied") store.set(viewer.workspaceReference, outcome.layout);
    return outcome;
  }

  function adopt(draft: WorkspaceLayoutModel, sessionProof: SessionProof): LayoutOutcome {
    const viewer = options.resolveViewer(sessionProof);
    if (viewer.kind === "guest") {
      // No server workspace exists yet — a guest cannot adopt into one.
      return {
        kind: "LayoutCommandOutcome",
        status: "rejected",
        reason: "unknown_widget",
        revision: brandReference<string, "Revision">("0"),
        layout: freshSeed(),
      };
    }
    // Merge: the draft geometry/panels win; the server revision advances by one so
    // reload restores the adopted board and any prior server revision is superseded.
    const base = serverLayout(viewer.workspaceReference);
    const merged: WorkspaceLayoutModel = { ...draft, revision: base.revision + 1 };
    store.set(viewer.workspaceReference, merged);
    return {
      kind: "LayoutCommandOutcome",
      status: "applied",
      idempotencyKey: `adopt:${viewer.workspaceReference}`,
      payloadHash: `adopt:${merged.revision}`,
      revision: brandReference<string, "Revision">(String(merged.revision)),
      layout: merged,
    };
  }

  // Dev/test seam: drop a workspace's persisted layout so the next open reseeds to revision 0.
  function reset(sessionProof: SessionProof): void {
    const viewer = options.resolveViewer(sessionProof);
    if (viewer.kind === "workspace") store.delete(viewer.workspaceReference);
  }

  return { open, changeLayout, adopt, reset };
}

export type LayoutService = ReturnType<typeof createLayoutService>;
