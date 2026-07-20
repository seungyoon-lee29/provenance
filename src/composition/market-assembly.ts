import type { MarketInformation } from "../modules/financial-information/data/contracts";
import type { Sleep } from "../modules/financial-information/data/deadline";
import { createKisMarketInformation } from "../modules/financial-information/data/kis-market-information";
import type { KisConfig, KisHttp } from "../modules/financial-information/data/kis-market-information";
import { catalogClock, createScriptedMarketInformation } from "../modules/financial-information/data/scripted-market-information";

// Composition seam for non-chart market data (ticket 26-a). `kis` wires the real personal provider
// (owner-scoped, gated upstream by kisMarketEnabled); `scripted` keeps the synthetic fallback for the
// network-off / non-configured lane. Relative imports: this module is exercised by a vitest test.

export type MarketBackend = "scripted" | "kis";
export type MarketAssembly = Readonly<{ provider: MarketInformation; backend: MarketBackend }>;
export type MarketClockDeps = Readonly<{ now(): number; sleep: Sleep }>;

export function assembleMarketInformation(
  backend: MarketBackend,
  deps: Readonly<{ clock: MarketClockDeps; kis?: Readonly<{ http: KisHttp; config: KisConfig }> }>,
): MarketAssembly {
  if (backend === "kis") {
    if (deps.kis === undefined) throw new Error("kis market backend requires kis credentials/config");
    return {
      backend,
      provider: createKisMarketInformation({ http: deps.kis.http, clock: deps.clock, config: deps.kis.config }),
    };
  }
  return { backend, provider: createScriptedMarketInformation(catalogClock()) };
}
