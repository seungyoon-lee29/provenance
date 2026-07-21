import { brandReference } from "../../../../shared/contracts/brands";
import type { InformationOutcome } from "@/shared";
import type { MarketInformation, MarketObservation } from "@/modules/financial-information/data/contracts";
import type { GuestViewerContext } from "@/shared/contracts/viewer-context";

import type {
  GuestFinancialInformation,
  GuestFinancialLoad,
  GuestFinancialQuery,
  GuestFinancialUpdates,
  GuestPanelValue,
} from "./contracts";

// Panels whose real public feed exists get a symbol; everything else stays the honest api_required
// stub until a redistributable source is wired (S&P/NASDAQ/KOSPI have none for guests — by license,
// not by omission).
const PANEL_SYMBOLS: Readonly<Partial<Record<GuestFinancialQuery["panelKey"], { symbol: string; label: string }>>> = {
  "index-us10y": { symbol: "UST10Y", label: "미국 10Y" },
  "index-usdkrw": { symbol: "USDKRW", label: "USD/KRW" },
};

/** Value only on available — a value-free market outcome passes through untouched (same contract). */
function toPanelOutcome(
  outcome: InformationOutcome<MarketObservation>,
  label: string,
): InformationOutcome<GuestPanelValue> {
  if (outcome.status !== "available") return outcome;
  // Display rounding only (derived crosses carry long fractions); the outcome's value is untouched.
  const rounded = Math.round(outcome.value.last * 100) / 100;
  const value: GuestPanelValue = {
    label,
    displayValue: `${rounded}${outcome.value.currency}`,
    unit: outcome.value.currency,
  };
  return { ...outcome, value };
}

export function createPublicFinancialInformation(
  deps: Readonly<{ market?: MarketInformation }> = {},
): GuestFinancialInformation {
  return {
    read(query: GuestFinancialQuery, viewer: GuestViewerContext): GuestFinancialLoad {
      const wired = PANEL_SYMBOLS[query.panelKey];
      if (wired && deps.market) {
        const load = deps.market.read(
          { kind: "FinancialQuery", symbol: wired.symbol, purpose: "public_display", requestRevision: query.requestRevision },
          viewer,
        );
        return {
          kind: "FinancialLoad",
          cache: load.cache,
          query,
          result: load.result.then((outcome) => toPanelOutcome(outcome, wired.label)),
        };
      }
      return {
        kind: "FinancialLoad",
        cache: "hit",
        query,
        result: Promise.resolve({
          status: "unavailable",
          reason: "api_required",
          requiredCapability: `public_${query.panelKey}`,
          configurationRoute: "/settings/providers",
          policyVersion: brandReference<string, "PolicyVersion">("policy:f1-public"),
        }),
      };
    },
    follow(): GuestFinancialUpdates {
      return { async *[Symbol.asyncIterator]() { return; } };
    },
  };
}
