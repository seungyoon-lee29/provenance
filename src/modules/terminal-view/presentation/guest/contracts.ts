import type {
  FinancialInformation,
  FinancialLoad,
  FinancialQuery,
  FinancialUpdates,
  InformationOutcome,
  SessionProof,
  TerminalLoad,
  TerminalRequest,
  TerminalView,
} from "@/shared";
import type { GuestViewerContext } from "@/shared/contracts/viewer-context";

export const publicPanelKeys = [
  "index-sp500",
  "index-nasdaq",
  "index-kospi",
  "index-usdkrw",
  "index-us10y",
  "market-overview",
  "watchlist",
  "filings",
  "market-landscape",
  "headlines",
  "macro",
  "data-quality",
] as const;

export type PublicPanelKey = (typeof publicPanelKeys)[number];

export type GuestPanelValue = Readonly<{
  label: string;
  displayValue: string;
  unit?: string;
}>;

export type GuestFinancialQuery = FinancialQuery & Readonly<{
  panelKey: PublicPanelKey;
  purpose: "public_display";
  requestRevision: string;
}>;

export type GuestFinancialLoad = FinancialLoad & Readonly<{
  cache: "hit" | "miss";
  query: GuestFinancialQuery;
  result: Promise<InformationOutcome<GuestPanelValue>>;
}>;

export type GuestFinancialUpdates = FinancialUpdates;

export interface GuestFinancialInformation extends FinancialInformation {
  read(query: GuestFinancialQuery, viewer: GuestViewerContext): GuestFinancialLoad;
}

export type GuestPanelPending = Readonly<{
  panelKey: PublicPanelKey;
  state: "pending";
  phase: "initial" | "provider_wait";
  since: number;
  requestRevision: string;
}>;

export type GuestPanelReady = Readonly<{
  panelKey: PublicPanelKey;
  state: "ready";
  outcome: InformationOutcome<GuestPanelValue>;
  requestRevision: string;
}>;

export type GuestPanelState = GuestPanelPending | GuestPanelReady;

export type GuestAccessState = Readonly<{
  state: "login_required";
  feature: "portfolio" | "paper_trading" | "ai" | "alerts";
}>;

export type GuestTerminalSnapshot = Readonly<{
  requestRevision: string;
  safetyDeadlineAfterMs: number;
  panels: readonly GuestPanelState[];
  access: readonly GuestAccessState[];
  syntheticMarker?: "SYNTHETIC TEST DATA";
}>;

export type GuestPanelUpdate = Readonly<{
  panelKey: PublicPanelKey;
  requestRevision: string;
  sequence: number;
  resumeIdentity: string;
  completed: boolean;
  state: GuestPanelState;
}>;

export type GuestTerminalRequest = TerminalRequest & Readonly<{
  mode: "guest";
  requestRevision: string;
  requestedPanels: readonly PublicPanelKey[];
}>;

export type GuestSessionProof = SessionProof & Readonly<{
  source: "server_guest";
  requestId: string;
}>;

export type GuestTerminalLoad = TerminalLoad & Readonly<{
  initial: Promise<GuestTerminalSnapshot>;
  updates: AsyncIterable<GuestPanelUpdate>;
  resumeIdentity: string;
  cancel(): void;
}>;

export interface GuestTerminalView extends Pick<TerminalView, "open"> {
  open(request: GuestTerminalRequest, proof: GuestSessionProof): GuestTerminalLoad;
}

export interface GuestClock {
  now(): number;
  sleep(durationMs: number, signal?: AbortSignal): Promise<void>;
}

export type GuestFixtureCase = Readonly<{
  id: string;
  panelKey: PublicPanelKey;
  cache: "hit" | "miss";
  settleAfterMs?: number | null;
  outcome: InformationOutcome<GuestPanelValue>;
}>;

export type GuestFixtureCatalog = Readonly<{
  marker: "SYNTHETIC TEST DATA";
  provider: "synthetic";
  isSynthetic: true;
  cases: readonly GuestFixtureCase[];
}>;
