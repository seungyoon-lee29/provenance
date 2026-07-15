import type {
  AccountSecurityDelivery,
  AdministrativeErasureCoordinator,
  AiMaterialResolver,
  AlertObservationResolver,
  BrokerPaperExecutionPort,
  BrokerReadPort,
  ChannelEndpointVault,
  DeliveryActionMaterialVault,
  DeliveryKeyring,
  EvidenceResolver,
  IdentityExecutionResolver,
  PortfolioEvidenceResolver,
  PortfolioWorkQueue,
  ProviderAuthorizationSeam,
} from "../src/shared/server";

type ServerOnlyPorts<AuthorizedTransport> = Readonly<{
  evidence: EvidenceResolver;
  portfolioEvidence: PortfolioEvidenceResolver;
  alertObservation: AlertObservationResolver;
  aiMaterial: AiMaterialResolver;
  identityExecution: IdentityExecutionResolver;
  erasure: AdministrativeErasureCoordinator;
  providerAuthorization: ProviderAuthorizationSeam<AuthorizedTransport>;
  accountSecurityDelivery: AccountSecurityDelivery;
  channelEndpointVault: ChannelEndpointVault;
  deliveryActionMaterialVault: DeliveryActionMaterialVault;
  deliveryKeyring: DeliveryKeyring;
  brokerRead: BrokerReadPort;
  brokerPaperExecution: BrokerPaperExecutionPort;
  portfolioWorkQueue: PortfolioWorkQueue;
}>;

function acceptsServerOnlyPorts<AuthorizedTransport>(ports: ServerOnlyPorts<AuthorizedTransport>) {
  return ports;
}

void acceptsServerOnlyPorts;
process.stdout.write("server-only seam example passed\n");
