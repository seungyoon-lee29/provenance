import type { RuntimeConfig } from "./runtime-policy";

export type CompositionManifest = Readonly<{
  paidAdapters: readonly string[];
  paidRoutes: readonly string[];
  paidSchedules: readonly string[];
  liveSubmitCapabilities: readonly string[];
  liveSubmitRoutes: readonly string[];
  syntheticProviders: readonly string[];
  identityProviders: readonly ("google" | "github")[];
}>;

export function buildCompositionManifest(config: RuntimeConfig): CompositionManifest {
  return {
    paidAdapters: [],
    paidRoutes: [],
    paidSchedules: [],
    liveSubmitCapabilities: [],
    liveSubmitRoutes: [],
    syntheticProviders: config.syntheticProviderEnabled ? ["scripted-test-provider"] : [],
    identityProviders: config.identityProviders,
  };
}

export function assertSafeComposition(config: RuntimeConfig, manifest: CompositionManifest): void {
  const forbiddenCount = manifest.paidAdapters.length + manifest.paidRoutes.length + manifest.paidSchedules.length + manifest.liveSubmitCapabilities.length + manifest.liveSubmitRoutes.length;
  if (forbiddenCount !== 0) throw new Error("unsafe paid or Live Trading composition registration");
  if (config.environment === "production" && manifest.syntheticProviders.length !== 0) {
    throw new Error("production composition contains a synthetic provider");
  }
}
