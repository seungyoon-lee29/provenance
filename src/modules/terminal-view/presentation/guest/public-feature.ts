import type { MarketInformation } from "@/modules/financial-information/data/contracts";

import type { GuestClock, GuestTerminalView } from "./contracts";
import { createGuestTerminalView, guestSystemClock } from "./guest-terminal-view";
import { createPublicFinancialInformation } from "./public-financial-information";
import { createScriptedFinancialInformation } from "./scripted-financial-information";

export type GuestFeatureEnvironment = "development" | "test" | "production";
export type GuestFeatureMode = "public" | "synthetic";

export function createGuestTerminalFeature(options: Readonly<{
  environment: GuestFeatureEnvironment;
  mode: GuestFeatureMode;
  clock?: GuestClock;
  scriptedHitDelayMs?: number;
  /** Real public-track provider (ticket 30-a); only the public composition consumes it. */
  publicMarket?: MarketInformation;
}>): Readonly<{
  terminalView: GuestTerminalView;
  marker?: "SYNTHETIC TEST DATA";
}> {
  if (options.environment === "production" && options.mode === "synthetic") {
    throw new Error("synthetic guest terminal fixture is forbidden in production");
  }
  const clock = options.clock ?? guestSystemClock;
  const synthetic = options.mode === "synthetic";
  return {
    terminalView: createGuestTerminalView({
      financialInformation: synthetic
        ? createScriptedFinancialInformation(clock, options.scriptedHitDelayMs)
        : createPublicFinancialInformation(options.publicMarket ? { market: options.publicMarket } : {}),
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
