import { cookies } from "next/headers";

import { GuestTerminalShell } from "@/modules/terminal-view/presentation/guest/guest-terminal-shell";
import { publicPanelKeys } from "@/modules/terminal-view/presentation/guest/contracts";
import {
  createGuestSessionProof,
  createGuestTerminalRequest,
} from "@/modules/terminal-view/presentation/guest/guest-terminal-view";
import { registerGuestTerminalLoad } from "@/modules/terminal-view/presentation/guest/guest-load-registry";
import {
  createGuestTerminalFeature,
  resolveGuestFeatureRuntime,
} from "@/modules/terminal-view/presentation/guest/public-feature";
import { resolveGuestChart } from "@/modules/terminal-view/presentation/chart/chart-server";
import { publicMarketServer } from "@/composition/public-market-server";
import { publicFilingsServer } from "@/composition/public-filings-server";
import { marketServer } from "@/composition/market-server";
import { identityServer } from "@/composition/identity-server";
import { SESSION_COOKIE } from "@/composition/session-cookie";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";

export const dynamic = "force-dynamic";

/** 세션이 있으면 그 워크스페이스 뷰어를, 없으면 undefined — 개인 소스는 이 값이 있을 때만 조립된다. */
async function resolveWorkspaceViewer(): Promise<WorkspaceViewerContext | undefined> {
  const proof = (await cookies()).get(SESSION_COOKIE)?.value;
  if (proof === undefined) return undefined;
  const viewer = await identityServer().resolve(proof);
  return viewer.kind === "workspace" ? viewer : undefined;
}

export default async function HomePage() {
  const runtime = resolveGuestFeatureRuntime(
    process.env.NODE_ENV,
    process.env.F1_SCRIPTED_PROVIDER_DELAY_MS,
    process.env.APP_ENVIRONMENT,
    process.env.F1_GUEST_MODE,
  );
  const viewer = await resolveWorkspaceViewer();
  const feature = createGuestTerminalFeature({
    ...runtime,
    publicMarket: publicMarketServer(),
    publicFilings: publicFilingsServer(),
    // 로그인 소유자는 같은 셸을 개인 데이터로 본다(ticket 36). 어댑터의 scope guard가 owner가
    // 아닌 워크스페이스에는 네트워크 0으로 값 없는 outcome을 준다.
    ...(viewer ? { personalMarket: marketServer().provider, viewer } : {}),
  });
  const requestId = crypto.randomUUID();
  const load = feature.terminalView.open(
    createGuestTerminalRequest(publicPanelKeys, `guest-${requestId}`),
    createGuestSessionProof(requestId),
  );
  const snapshot = await load.initial;
  // 개인 값이 흐르는 핸드오프는 그 계정만 이어받는다.
  registerGuestTerminalLoad(
    requestId,
    snapshot.requestRevision,
    load,
    viewer ? String(viewer.accountReference) : undefined,
  );
  const updateUrl = `/api/guest-terminal/updates?requestId=${encodeURIComponent(requestId)}&revision=${encodeURIComponent(snapshot.requestRevision)}`;
  const chart = await resolveGuestChart(runtime.mode);

  return (
    <GuestTerminalShell
      snapshot={snapshot}
      updateUrl={updateUrl}
      chart={chart}
      {...(viewer ? { account: { reference: String(viewer.accountReference) } } : {})}
    />
  );
}
