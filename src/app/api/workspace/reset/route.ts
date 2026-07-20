import { NextResponse } from "next/server";

import { devWorkspaceProof, isDevWorkspaceMode, resetWorkspaceLayout } from "@/modules/terminal-view/presentation/workspace/workspace-server";

// Dev/test-only: resets the auto-provisioned workspace layout to the seed so browser tests
// start each case from revision 0 (the shared in-memory singleton would otherwise leak state).
export async function POST(): Promise<NextResponse> {
  if (!isDevWorkspaceMode()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await resetWorkspaceLayout(await devWorkspaceProof());
  return NextResponse.json({ ok: true });
}
