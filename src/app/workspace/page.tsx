import { cookies } from "next/headers";

import { WorkspaceLayout } from "@/modules/terminal-view/layout/workspace-layout";
import { devWorkspaceProof, isDevWorkspaceMode, openWorkspaceLayout } from "@/modules/terminal-view/presentation/workspace/workspace-server";
import { identityServer } from "@/composition/identity-server";
import { SESSION_COOKIE } from "@/composition/session-cookie";
import { AccountPanel } from "./account-panel";

export const dynamic = "force-dynamic";

async function resolveAccount(): Promise<{ accountReference: string; vaultDisabled: boolean } | undefined> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (value === undefined) return undefined;
  const server = identityServer();
  const viewer = await server.resolve(value);
  if (viewer.kind !== "workspace") return undefined;
  return { accountReference: String(viewer.accountReference), vaultDisabled: server.vaultDisabled };
}

export default async function WorkspacePage() {
  const account = await resolveAccount();

  // Guest/no-cookie in dev/test still auto-provisions the layout so the browser/perf specs render
  // the seeded grid. A real cookie session additionally shows the account + connections overlay.
  if (!isDevWorkspaceMode() && account === undefined) {
    return (
      <main style={{ padding: "16px" }}>
        <h1>워크스페이스</h1>
        <p>로그인이 필요합니다.</p>
        <a href="/signin">로그인</a>
      </main>
    );
  }

  const proof = await devWorkspaceProof();
  const initial = await openWorkspaceLayout(proof);

  return (
    <main style={{ padding: "12px", boxSizing: "border-box" }}>
      <h1 style={{ fontSize: "1.1rem", margin: "0 0 8px" }}>워크스페이스 레이아웃</h1>
      {account !== undefined ? (
        <AccountPanel accountReference={account.accountReference} vaultDisabled={account.vaultDisabled} />
      ) : null}
      <WorkspaceLayout initial={initial} persistUrl="/api/workspace/layout" />
    </main>
  );
}
