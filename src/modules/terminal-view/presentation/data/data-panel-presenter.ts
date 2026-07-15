import type { InformationOutcome, ResearchResult } from "@/shared";

import type { MarketObservation } from "../../../financial-information/data/contracts";
import type { EvidenceValue } from "../../../financial-information/data/evidence-contracts";
import type { ResearchResultShape } from "../../../research-assistant/contracts";
import type { GuestPanelValue } from "../guest/contracts";
import { presentGuestPanel, type GuestPanelPresentation } from "../guest/guest-panel-presenter";

/**
 * F4 panels reuse the F1-proven outcome presenter so the AT-01 DOM invariant —
 * a value renders ONLY on `available`, unavailable/failed render provenance
 * with no value — holds identically for market/evidence/research. Each adapter
 * only maps the typed value to the presenter's display shape; every non-value
 * branch passes straight through untouched.
 */
function mapOutcome<T>(
  outcome: InformationOutcome<T>,
  toValue: (value: T) => GuestPanelValue,
): InformationOutcome<GuestPanelValue> {
  return outcome.status === "available" ? { ...outcome, value: toValue(outcome.value) } : outcome;
}

function present(outcome: InformationOutcome<GuestPanelValue>): GuestPanelPresentation {
  return presentGuestPanel({ state: "ready", outcome, requestRevision: "" });
}

export function marketToValue(observation: MarketObservation): GuestPanelValue {
  const sign = observation.change >= 0 ? "+" : "";
  return {
    label: observation.symbol,
    displayValue: `${observation.last.toFixed(2)} ${observation.currency}`,
    unit: `${sign}${observation.changePercent.toFixed(2)}%`,
  };
}

export function evidenceToValue(value: EvidenceValue): GuestPanelValue {
  if (value.kind === "news") {
    return { label: `뉴스 ${value.headlines.length}건`, displayValue: value.headlines[0]?.title ?? "" };
  }
  return { label: `공시 ${value.filings.length}건`, displayValue: value.filings[0]?.form ?? "" };
}

export function researchToValue(result: ResearchResultShape): GuestPanelValue {
  return { label: result.producedBy === "gemini" ? "AI 요약" : "로컬 요약", displayValue: result.answer };
}

export function presentMarketPanel(outcome: InformationOutcome<MarketObservation>): GuestPanelPresentation {
  return present(mapOutcome(outcome, marketToValue));
}

export function presentEvidencePanel(outcome: InformationOutcome<EvidenceValue>): GuestPanelPresentation {
  return present(mapOutcome(outcome, evidenceToValue));
}

export function presentResearchPanel(outcome: InformationOutcome<ResearchResult>): GuestPanelPresentation {
  // The service's available value is always a ResearchResultShape at runtime.
  return present(mapOutcome(outcome, (value) => researchToValue(value as ResearchResultShape)));
}
