import type { AiMaterialReference } from "./brands";
import type { InformationOutcome } from "./information-outcome";
import type { MutationControl } from "./mutation-control";
import type { ViewerContext } from "./viewer-context";

export type ContractValue<Name extends string> = Readonly<{ kind: Name }>;
export type ContractStream<Item> = AsyncIterable<Item>;

export type FinancialQuery = ContractValue<"FinancialQuery">;
export type FinancialLoad = ContractValue<"FinancialLoad">;
export type FinancialUpdates = ContractStream<ContractValue<"FinancialUpdate">>;
export type ResearchTask = ContractValue<"ResearchTask">;
export type ResearchResult = ContractValue<"ResearchResult">;
export type SessionProof = ContractValue<"SessionProof">;
export type ClientProof = ContractValue<"ClientProof">;
export type AccountEmailCommand = ContractValue<"AccountEmailCommand">;
export type AccountEmailOutcome = ContractValue<"AccountEmailOutcome">;
export type SessionOutcome = ContractValue<"SessionOutcome">;
export type InternalRoute = ContractValue<"InternalRoute">;
export type FederatedCallbackProof = ContractValue<"FederatedCallbackProof">;
export type FederatedSignInIntent = ContractValue<"FederatedSignInIntent">;
export type ReauthenticationProof = ContractValue<"ReauthenticationProof">;
export type ErasureCommandOutcome = ContractValue<"ErasureCommandOutcome">;
export type ProviderConnectionView = ContractValue<"ProviderConnectionView">;
export type SaveProviderConnection = ContractValue<"SaveProviderConnection">;
export type VerifyProviderConnection = ContractValue<"VerifyProviderConnection">;
export type RevokeProviderConnection = ContractValue<"RevokeProviderConnection">;
export type ProviderConnectionOutcome = ContractValue<"ProviderConnectionOutcome">;
export type ActualPortfolioRequest = ContractValue<"ActualPortfolioRequest">;
export type ActualPortfolioView = ContractValue<"ActualPortfolioView">;
export type ActualPortfolioCommand = ContractValue<"ActualPortfolioCommand">;
export type ActualCommandOutcome = ContractValue<"ActualCommandOutcome">;
export type PaperPortfolioRequest = ContractValue<"PaperPortfolioRequest">;
export type PaperPortfolioView = ContractValue<"PaperPortfolioView">;
export type PreparePaperOrder = ContractValue<"PreparePaperOrder">;
export type PaperOrderIntent = ContractValue<"PaperOrderIntent">;
export type SubmitOrCancelPaperOrder = ContractValue<"SubmitOrCancelPaperOrder">;
export type PaperCommandOutcome = ContractValue<"PaperCommandOutcome">;
export type NotificationRequest = ContractValue<"NotificationRequest">;
export type NotificationLoad = ContractValue<"NotificationLoad">;
export type AlertRuleCommand = ContractValue<"AlertRuleCommand">;
export type ChannelCommand = ContractValue<"ChannelCommand">;
export type AcknowledgeNotification = ContractValue<"AcknowledgeNotification">;
export type NotificationCommandOutcome = ContractValue<"NotificationCommandOutcome">;
export type TerminalRequest = ContractValue<"TerminalRequest">;
export type TerminalLoad = ContractValue<"TerminalLoad">;
export type ChangeWorkspaceLayout = ContractValue<"ChangeWorkspaceLayout">;
export type LayoutCommandOutcome = ContractValue<"LayoutCommandOutcome">;
export type PortfolioLoad<T> = Readonly<{ initial: Promise<T>; updates: ContractStream<ContractValue<"PortfolioUpdate">> }>;

export interface FinancialInformation {
  read(query: FinancialQuery, viewer: ViewerContext): FinancialLoad;
  follow(query: FinancialQuery, viewer: ViewerContext): FinancialUpdates;
}

export interface ResearchAssistant {
  run(task: ResearchTask, materialReferences: AiMaterialReference[], viewer: ViewerContext): Promise<InformationOutcome<ResearchResult>>;
}

export interface Identity {
  resolve(sessionProof: SessionProof): ViewerContext;
  requestAccountEmail(command: AccountEmailCommand, control: Readonly<{ idempotencyKey: string }>, clientProof: ClientProof): Promise<AccountEmailOutcome>;
  consumeAccountChallenge(command: Readonly<{ kind: "link" | "manual_code"; proof: string }>, clientProof: ClientProof): Promise<SessionOutcome>;
  beginFederatedSignIn(command: Readonly<{ provider: "google" | "github"; returnRoute: InternalRoute }>, clientProof: ClientProof): Promise<FederatedSignInIntent>;
  consumeFederatedSignIn(command: Readonly<{ provider: "google" | "github"; callbackProof: FederatedCallbackProof }>, clientProof: ClientProof): Promise<SessionOutcome>;
  revokeSession(command: Readonly<{ scope: "current" | "all" }>, control: MutationControl, sessionProof: SessionProof): Promise<SessionOutcome>;
  requestAdministrativeErasure(command: Readonly<{ scope: "workspace" | "account"; confirmationProof: ReauthenticationProof }>, control: MutationControl, sessionProof: SessionProof): Promise<ErasureCommandOutcome>;
}

export interface ProviderConnections {
  list(viewer: ViewerContext): Promise<ProviderConnectionView[]>;
  save(command: SaveProviderConnection, control: MutationControl, viewer: ViewerContext): Promise<ProviderConnectionOutcome>;
  verify(command: VerifyProviderConnection, control: MutationControl, viewer: ViewerContext): Promise<ProviderConnectionOutcome>;
  revoke(command: RevokeProviderConnection, control: MutationControl, viewer: ViewerContext): Promise<ProviderConnectionOutcome>;
}

export interface ActualPortfolio {
  open(request: ActualPortfolioRequest, viewer: ViewerContext): PortfolioLoad<ActualPortfolioView>;
  change(command: ActualPortfolioCommand, control: MutationControl, viewer: ViewerContext): Promise<ActualCommandOutcome>;
}

export interface PaperTrading {
  open(request: PaperPortfolioRequest, viewer: ViewerContext): PortfolioLoad<PaperPortfolioView>;
  prepare(request: PreparePaperOrder, viewer: ViewerContext): Promise<InformationOutcome<PaperOrderIntent>>;
  change(command: SubmitOrCancelPaperOrder, control: MutationControl, viewer: ViewerContext): Promise<PaperCommandOutcome>;
}

export interface NotificationCenter {
  open(request: NotificationRequest, viewer: ViewerContext): NotificationLoad;
  changeRule(command: AlertRuleCommand, control: MutationControl, viewer: ViewerContext): Promise<NotificationCommandOutcome>;
  changeChannel(command: ChannelCommand, control: MutationControl, viewer: ViewerContext): Promise<NotificationCommandOutcome>;
  acknowledge(command: AcknowledgeNotification, control: MutationControl, viewer: ViewerContext): Promise<NotificationCommandOutcome>;
}

export interface TerminalView {
  open(request: TerminalRequest, sessionProof: SessionProof): TerminalLoad;
  changeLayout(command: ChangeWorkspaceLayout, control: MutationControl, sessionProof: SessionProof): Promise<LayoutCommandOutcome>;
}
