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

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const runtime = resolveGuestFeatureRuntime(
    process.env.NODE_ENV,
    process.env.F1_SCRIPTED_PROVIDER_DELAY_MS,
    process.env.APP_ENVIRONMENT,
    process.env.F1_GUEST_MODE,
  );
  const feature = createGuestTerminalFeature({ ...runtime, publicMarket: publicMarketServer() });
  const requestId = crypto.randomUUID();
  const load = feature.terminalView.open(
    createGuestTerminalRequest(publicPanelKeys, `guest-${requestId}`),
    createGuestSessionProof(requestId),
  );
  const snapshot = await load.initial;
  registerGuestTerminalLoad(requestId, snapshot.requestRevision, load);
  const updateUrl = `/api/guest-terminal/updates?requestId=${encodeURIComponent(requestId)}&revision=${encodeURIComponent(snapshot.requestRevision)}`;
  const chart = await resolveGuestChart(runtime.mode);

  return <GuestTerminalShell snapshot={snapshot} updateUrl={updateUrl} chart={chart} />;
}
