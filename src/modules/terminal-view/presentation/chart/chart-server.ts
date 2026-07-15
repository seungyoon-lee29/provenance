import { brandReference } from "../../../../shared/contracts/brands";
import { defaultChartSelection } from "../../../financial-information/chart/chart-manifest";
import { createScriptedChartInformation } from "../../../financial-information/chart/scripted-chart-information";
import type { GuestViewerContext } from "@/shared/contracts/viewer-context";

import { chartSystemClock, readInitialChartFrame } from "./chart-tracer";
import type { ChartFrame } from "./chart-tracer";

export type GuestChartMode = "synthetic" | "public";

export type GuestChartProps = Readonly<{
  mode: GuestChartMode;
  initialFrame: ChartFrame;
}>;

const guestChartViewer: GuestViewerContext = { kind: "guest", requestId: "guest-chart" };

/**
 * Resolve the SSR initial chart frame for the guest workspace. Synthetic mode
 * (dev/test/network-off) reads the scripted provider so the frame ships in the
 * first paint and the client can drive selections. Public mode ships no
 * synthetic data: the chart shows an honest `api_required` outcome until a real
 * provider contract is enabled (F11 opt-in).
 */
export async function resolveGuestChart(mode: GuestChartMode): Promise<GuestChartProps> {
  if (mode === "synthetic") {
    const chart = createScriptedChartInformation(chartSystemClock);
    const initialFrame = await readInitialChartFrame(chart, guestChartViewer, defaultChartSelection);
    return { mode, initialFrame };
  }
  return {
    mode,
    initialFrame: {
      revision: 0,
      selection: defaultChartSelection,
      outcome: {
        status: "unavailable",
        reason: "api_required",
        requiredCapability: "public_chart_display",
        configurationRoute: "/settings/providers",
        policyVersion: brandReference<string, "PolicyVersion">("policy:f2-public"),
      },
    },
  };
}
