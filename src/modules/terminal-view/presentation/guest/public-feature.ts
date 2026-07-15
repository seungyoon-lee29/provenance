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
        : createPublicFinancialInformation(),
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
): Readonly<{
  environment: GuestFeatureEnvironment;
  mode: GuestFeatureMode;
  scriptedHitDelayMs?: number;
}> {
  if (nodeEnvironment === "production" && appEnvironment !== "test") {
    return { environment: "production", mode: "public" };
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
