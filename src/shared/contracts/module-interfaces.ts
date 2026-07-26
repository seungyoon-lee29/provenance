// Public port catalog — transcribed from spec §6 at F0 (560e7d3) and NARROWED since.
//
// An entry earns its place here only while a real module consumes it (`extends`, `Pick<>`).
// Ports whose modules were deleted were removed 2026-07-26 rather than left advertised:
// a name exported from `src/shared` reads as "this exists", and three separate progress
// documents had already re-litigated the same dangling entries.
// Deleted then: ResearchAssistant (Stage 1), NotificationCenter (Stage 2 T3),
// ActualPortfolio (Stage 2 T4), plus Identity and PaperTrading — those two were worse than
// dead, because `identity/contracts.ts` and `paper-trading/internal/contracts.ts` re-declare
// their value-type names with DIFFERENT shapes, and both reach callers through this barrel.
// Rationale and the deferral entries it overrides:
// .scratch/financial-terminal/progress/stage3-prep-port-catalog.md
//
// The value types below are phantom tags (`{ kind: Name }`), not data shapes. Real modules
// intersect them (`ChartLoad = FinancialLoad & {...}`) or narrow the port (`extends`).
// A module's actual contract lives beside the module, in `src/modules/*/contracts.ts`.
import type { MutationControl } from "./mutation-control";
import type { ViewerContext } from "./viewer-context";

export type ContractValue<Name extends string> = Readonly<{ kind: Name }>;
export type ContractStream<Item> = AsyncIterable<Item>;

export type FinancialQuery = ContractValue<"FinancialQuery">;
export type FinancialLoad = ContractValue<"FinancialLoad">;
export type FinancialUpdates = ContractStream<ContractValue<"FinancialUpdate">>;
export type SessionProof = ContractValue<"SessionProof">;
export type ProviderConnectionView = ContractValue<"ProviderConnectionView">;
export type SaveProviderConnection = ContractValue<"SaveProviderConnection">;
export type VerifyProviderConnection = ContractValue<"VerifyProviderConnection">;
export type RevokeProviderConnection = ContractValue<"RevokeProviderConnection">;
export type ProviderConnectionOutcome = ContractValue<"ProviderConnectionOutcome">;
export type TerminalRequest = ContractValue<"TerminalRequest">;
export type TerminalLoad = ContractValue<"TerminalLoad">;
export type ChangeWorkspaceLayout = ContractValue<"ChangeWorkspaceLayout">;
export type LayoutCommandOutcome = ContractValue<"LayoutCommandOutcome">;

/** Consumed by ChartInformation, MarketInformation and GuestFinancialInformation. */
export interface FinancialInformation {
  read(query: FinancialQuery, viewer: ViewerContext): FinancialLoad;
  follow(query: FinancialQuery, viewer: ViewerContext): FinancialUpdates;
}

/** Consumed by ProviderConnectionsCore. NOTE: that file holds a NUL byte (map-key delimiter),
 *  so `file(1)` calls it `data` and plain grep/rg skip it — use `-a` when auditing this port. */
export interface ProviderConnections {
  list(viewer: ViewerContext): Promise<ProviderConnectionView[]>;
  save(command: SaveProviderConnection, control: MutationControl, viewer: ViewerContext): Promise<ProviderConnectionOutcome>;
  verify(command: VerifyProviderConnection, control: MutationControl, viewer: ViewerContext): Promise<ProviderConnectionOutcome>;
  revoke(command: RevokeProviderConnection, control: MutationControl, viewer: ViewerContext): Promise<ProviderConnectionOutcome>;
}

/** Consumed by GuestTerminalView via `Pick<TerminalView, "open">`. */
export interface TerminalView {
  open(request: TerminalRequest, sessionProof: SessionProof): TerminalLoad;
  changeLayout(command: ChangeWorkspaceLayout, control: MutationControl, sessionProof: SessionProof): Promise<LayoutCommandOutcome>;
}
