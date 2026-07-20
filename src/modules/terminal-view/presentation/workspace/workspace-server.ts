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

async function singleton(): Promise<WorkspaceSingleton> {
  if (globalStore.__ftWorkspace !== undefined) return globalStore.__ftWorkspace;
  const store = new IdentitySessionStore(realClock, realEntropy);
  const devAccount = await store.ensureEmailAccount("dev@workspace.local");
  const devSession = await store.issueSession(devAccount.accountReference, await store.primaryWorkspace(devAccount));
  // The layout module's resolveViewer is a sync seam by design. This dev shim only ever holds the one
  // dev session, so resolve it once at bootstrap and hand layout a cached sync resolver — any other
  // proof maps to guest, matching the store's not-found behaviour.
  const devViewer = await store.resolve(devSession.proof);
  const service = createLayoutService({
    seed: WORKSPACE_SEED,
    resolveViewer: (proof) =>
      (proof as unknown as SessionProof).value === devSession.proof.value ? devViewer : { kind: "guest", requestId: realEntropy.token(8) },
  });
  globalStore.__ftWorkspace = { devProof: devSession.proof, service };
  return globalStore.__ftWorkspace;
}

/** Auth is not wired yet: dev/test auto-provisions a stable workspace session so the surface renders. */
export function isDevWorkspaceMode(): boolean {
  const environment = process.env.APP_ENVIRONMENT;
  return environment === "development" || environment === "test";
}

export async function devWorkspaceProof(): Promise<SharedSessionProof> {
  return (await singleton()).devProof as unknown as SharedSessionProof;
}

export async function openWorkspaceLayout(proof: SharedSessionProof): Promise<WorkspaceLayoutModel> {
  return (await singleton()).service.open(proof);
}

export async function changeWorkspaceLayout(command: ChangeWorkspaceLayoutCommand, control: Parameters<ReturnType<typeof createLayoutService>["changeLayout"]>[1], proof: SharedSessionProof): Promise<LayoutOutcome> {
  return (await singleton()).service.changeLayout(command, control, proof);
}

export async function resetWorkspaceLayout(proof: SharedSessionProof): Promise<void> {
  (await singleton()).service.reset(proof);
}
