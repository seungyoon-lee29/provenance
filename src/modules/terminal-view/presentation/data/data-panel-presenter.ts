import type { InformationOutcome, ResearchResult } from "@/shared";

import type { MarketObservation } from "../../../financial-information/data/contracts";
import type { EvidenceValue } from "../../../financial-information/data/evidence-contracts";
import type { ResearchResultShape } from "../../../research-assistant/contracts";
import type { GuestPanelState, GuestPanelValue, PublicPanelKey } from "../guest/contracts";
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

/**
 * DOM-mount seam: wrap an F4 outcome as a `GuestPanelState` so the F1-proven
 * `GuestPanel` component renders it unchanged. The AT-01 invariant then holds in
 * the literal browser DOM, not only in the view-model unit tests above.
 */
function panelState(id: string, outcome: InformationOutcome<GuestPanelValue>): GuestPanelState {
  // ponytail: `id` is a scenario id used only as an opaque DOM/aria key; cast to reuse GuestPanel as-is.
  return { panelKey: id as PublicPanelKey, state: "ready", outcome, requestRevision: "" };
}

export function toMarketPanelState(id: string, outcome: InformationOutcome<MarketObservation>): GuestPanelState {
  return panelState(id, mapOutcome(outcome, marketToValue));
}

export function toEvidencePanelState(id: string, outcome: InformationOutcome<EvidenceValue>): GuestPanelState {
  return panelState(id, mapOutcome(outcome, evidenceToValue));
}

export function toResearchPanelState(id: string, outcome: InformationOutcome<ResearchResult>): GuestPanelState {
  return panelState(id, mapOutcome(outcome, (value) => researchToValue(value as ResearchResultShape)));
}
