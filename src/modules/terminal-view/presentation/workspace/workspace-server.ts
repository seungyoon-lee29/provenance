import "server-only";

import { randomBytes } from "node:crypto";

import type { SessionProof as SharedSessionProof } from "../../../../shared/contracts/module-interfaces";
import type { EntropySource, IdentityClock, SessionProof } from "../../../identity/contracts";
import { IdentitySessionStore } from "../../../identity/session-store";
import { createLayoutService } from "../../layout/layout-service";
import type { ChangeWorkspaceLayoutCommand, LayoutOutcome, LayoutWidget, WorkspaceLayoutModel } from "../../layout/contracts";

// Default board the browser/perf specs assert on: two widgets, revision 0.
const WORKSPACE_SEED: readonly LayoutWidget[] = [
  { widgetId: "chart", geometry: { x: 0, y: 0, w: 6, h: 8 }, panes: 1 },
  { widgetId: "watchlist", geometry: { x: 6, y: 0, w: 3, h: 8 }, panes: 1 },
];

const realClock: IdentityClock = { now: () => Date.now() };
const realEntropy: EntropySource = { token: (bytes = 16) => randomBytes(bytes).toString("base64url") };

type WorkspaceSingleton = Readonly<{ devProof: SessionProof; service: ReturnType<typeof createLayoutService> }>;

// ponytail: in-memory singleton (no DB). Anchored on globalThis because Next.js can hand each route
// bundle (the /workspace page vs the /api/workspace/* handlers) its own module instance — a plain
// module-level const would let the page read a different store than the API writes.
const globalStore = globalThis as unknown as { __ftWorkspace?: WorkspaceSingleton };

function singleton(): WorkspaceSingleton {
  if (globalStore.__ftWorkspace !== undefined) return globalStore.__ftWorkspace;
  const store = new IdentitySessionStore(realClock, realEntropy);
  const devAccount = store.ensureEmailAccount("dev@workspace.local");
  const devSession = store.issueSession(devAccount.accountReference, store.primaryWorkspace(devAccount));
  const service = createLayoutService({
    seed: WORKSPACE_SEED,
    // The layout module only knows the shared opaque SessionProof; the concrete identity proof
    // (carrying the secret value) flows through at runtime, so bridge the two here.
    resolveViewer: (proof) => store.resolve(proof as unknown as SessionProof),
  });
  globalStore.__ftWorkspace = { devProof: devSession.proof, service };
  return globalStore.__ftWorkspace;
}

/** Auth is not wired yet: dev/test auto-provisions a stable workspace session so the surface renders. */
export function isDevWorkspaceMode(): boolean {
  const environment = process.env.APP_ENVIRONMENT;
  return environment === "development" || environment === "test";
}

export function devWorkspaceProof(): SharedSessionProof {
  return singleton().devProof as unknown as SharedSessionProof;
}

export function openWorkspaceLayout(proof: SharedSessionProof): WorkspaceLayoutModel {
  return singleton().service.open(proof);
}

export function changeWorkspaceLayout(command: ChangeWorkspaceLayoutCommand, control: Parameters<ReturnType<typeof createLayoutService>["changeLayout"]>[1], proof: SharedSessionProof): LayoutOutcome {
  return singleton().service.changeLayout(command, control, proof);
}

export function resetWorkspaceLayout(proof: SharedSessionProof): void {
  singleton().service.reset(proof);
}
