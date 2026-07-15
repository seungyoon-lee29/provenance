import type {
  AdministrativeErasureReference,
  AiMaterialReference,
  DeliveryEndpointReference,
  DeliveryTargetReference,
  FinancialDeliveryReference,
  JobContextReference,
  ProviderConnectionReference,
  SecurityEventReference,
  SourceReference,
} from "../contracts/brands";
import type { InformationOutcome } from "../contracts/information-outcome";
import type { ViewerContext } from "../contracts/viewer-context";

export type ServerContractValue<Name extends string> = Readonly<{ kind: Name }>;
export type EvidencePurpose = "research" | "portfolio_calculation" | "alert_evaluation";
export type AiMaterialPurpose = "research";

export interface EvidenceResolver {
  resolve(reference: SourceReference, purpose: EvidencePurpose, viewer: ViewerContext): Promise<InformationOutcome<ServerContractValue<"EvidenceEnvelope">>>;
}

export interface PortfolioEvidenceResolver {
  resolve(reference: SourceReference, calculationPurpose: string, viewer: ViewerContext): Promise<InformationOutcome<ServerContractValue<"PortfolioEvidenceEnvelope">>>;
}

export interface AlertObservationResolver {
  resolve(reference: SourceReference, condition: ServerContractValue<"AlertCondition">, viewer: ViewerContext): Promise<InformationOutcome<ServerContractValue<"AlertObservationEnvelope">>>;
}

export interface AiMaterialResolver {
  resolve(reference: AiMaterialReference, purpose: AiMaterialPurpose, viewer: ViewerContext): Promise<InformationOutcome<ServerContractValue<"AiMaterialEnvelope">>>;
}

export interface IdentityExecutionResolver {
  resolveJob(reference: JobContextReference): Promise<InformationOutcome<ServerContractValue<"JobAuthorizationContext">>>;
  resolveFinancialDelivery(reference: FinancialDeliveryReference): Promise<InformationOutcome<ServerContractValue<"FinancialDeliveryContext">>>;
  resolveAccountChallengeDelivery(eventReference: SecurityEventReference, targetReference: DeliveryTargetReference): Promise<InformationOutcome<ServerContractValue<"AccountChallengeDeliveryContext">>>;
  resolveSecurityNoticeDelivery(eventReference: SecurityEventReference, endpointReference: DeliveryEndpointReference): Promise<InformationOutcome<ServerContractValue<"SecurityNoticeDeliveryContext">>>;
}

export interface AdministrativeErasureCoordinator {
  execute(reference: AdministrativeErasureReference): Promise<ServerContractValue<"AdministrativeErasureReceipt">>;
}

export interface ProviderAuthorizationSeam<AuthorizedTransport> {
  authorize(connection: ProviderConnectionReference, purpose: string, viewer: ViewerContext): Promise<AuthorizedTransport>;
}

export interface AccountSecurityDelivery {
  plan(event: ServerContractValue<"AccountSecurityEvent">): Promise<ServerContractValue<"DeliveryIntent">>;
}

export interface ChannelEndpointVault {
  seal(endpoint: Uint8Array, context: ServerContractValue<"ChannelEndpointAad">): Promise<ServerContractValue<"ChannelEndpointEnvelope">>;
}

export interface DeliveryActionMaterialVault {
  seal(material: Uint8Array, context: ServerContractValue<"DeliveryActionMaterialAad">): Promise<ServerContractValue<"DeliveryActionMaterialEnvelope">>;
}

export interface DeliveryKeyring {
  loadActive(purpose: string): Promise<ServerContractValue<"ActiveDeliveryKey">>;
  loadUnexpiredPrevious(purpose: string): Promise<readonly ServerContractValue<"PreviousDeliveryKey">[]>;
}

export interface BrokerReadPort {
  read(request: ServerContractValue<"BrokerReadRequest">): Promise<InformationOutcome<ServerContractValue<"BrokerReadEnvelope">>>;
}

export interface BrokerPaperExecutionPort {
  execute(request: ServerContractValue<"BrokerPaperExecutionRequest">): Promise<ServerContractValue<"BrokerPaperExecutionReceipt">>;
}

export interface PortfolioWorkQueue {
  enqueue(reference: JobContextReference): Promise<void>;
}
