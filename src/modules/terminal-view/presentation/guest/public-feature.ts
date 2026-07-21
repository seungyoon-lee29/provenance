import type { MarketInformation } from "@/modules/financial-information/data/contracts";
import type { FilingsInformation } from "@/modules/financial-information/data/dart-filings-information";

import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";

import type { GuestClock, GuestTerminalView } from "./contracts";
import { createGuestTerminalView, guestSystemClock } from "./guest-terminal-view";
import { createPersonalFinancialInformation } from "./personal-financial-information";
import { createPublicFinancialInformation } from "./public-financial-information";
import { createScriptedFinancialInformation } from "./scripted-financial-information";

export type GuestFeatureEnvironment = "development" | "test" | "production";
export type GuestFeatureMode = "public" | "synthetic";

export function createGuestTerminalFeature(options: Readonly<{
  environment: GuestFeatureEnvironment;
  mode: GuestFeatureMode;
  clock?: GuestClock;
  scriptedHitDelayMs?: number;
  /** Real public-track providers (tickets 30-a, 33-b); only the public composition consumes them. */
  publicMarket?: MarketInformation;
  publicFilings?: FilingsInformation;
  /** 로그인 소유자 트랙 (ticket 36): 둘 다 있을 때만 개인 소스를 조립한다. */
  personalMarket?: MarketInformation;
  viewer?: WorkspaceViewerContext;
}>): Readonly<{
  terminalView: GuestTerminalView;
  marker?: "SYNTHETIC TEST DATA";
}> {
  if (options.environment === "production" && options.mode === "synthetic") {
    throw new Error("synthetic guest terminal fixture is forbidden in production");
  }
  const clock = options.clock ?? guestSystemClock;
  const synthetic = options.mode === "synthetic";
  const publicInformation = createPublicFinancialInformation({
    ...(options.publicMarket ? { market: options.publicMarket } : {}),
    ...(options.publicFilings ? { filings: options.publicFilings } : {}),
  });
  // 개인 소스는 세션 뷰어가 있을 때만 조립된다 — 게스트 조립 경로에는 존재조차 하지 않는다.
  const information = options.personalMarket && options.viewer
    ? createPersonalFinancialInformation({
        market: options.personalMarket,
        viewer: options.viewer,
        fallback: publicInformation,
      })
    : publicInformation;
  return {
    terminalView: createGuestTerminalView({
      financialInformation: synthetic
        ? createScriptedFinancialInformation(clock, options.scriptedHitDelayMs)
        : information,
      clock,
      ...(synthetic ? { syntheticMarker: "SYNTHETIC TEST DATA" as const } : {}),
    }),
    ...(synthetic ? { marker: "SYNTHETIC TEST DATA" as const } : {}),
  };
}

export function resolveGuestFeatureRuntime(
  nodeEnvironment: string | undefined,
  scriptedHitDelay: string | undefined = undefined,
  appEnvironment: string | undefined = undefined,
  guestModeOverride: string | undefined = undefined,
): Readonly<{
  environment: GuestFeatureEnvironment;
  mode: GuestFeatureMode;
  scriptedHitDelayMs?: number;
}> {
  if (nodeEnvironment === "production" && appEnvironment !== "test") {
    return { environment: "production", mode: "public" };
  }
  // Dev/test QA opt-in (ticket 30-b): F1_GUEST_MODE=public composes the real public track locally.
  // Only this one direction exists — production can never opt INTO synthetic (fence above).
  if (guestModeOverride === "public") {
    return { environment: appEnvironment === "test" ? "test" : "development", mode: "public" };
  }
  const parsedDelay = Number(scriptedHitDelay ?? 0);
  const scriptedHitDelayMs = Number.isFinite(parsedDelay) && parsedDelay >= 0 && parsedDelay <= 1_000
    ? parsedDelay
    : 0;
  return {
    environment: appEnvironment === "test" ? "test" : "development",
    mode: "synthetic",
    scriptedHitDelayMs,
  };
}
