import type {
  ActualPortfolio,
  FinancialInformation,
  Identity,
  InformationOutcome,
  NotificationCenter,
  PaperTrading,
  PolicyVersion,
  ProviderConnections,
  ResearchAssistant,
  TerminalView,
} from "../src/shared";

type PublicPorts = Readonly<{
  actualPortfolio: ActualPortfolio;
  financialInformation: FinancialInformation;
  researchAssistant: ResearchAssistant;
  identity: Identity;
  providerConnections: ProviderConnections;
  paperTrading: PaperTrading;
  notificationCenter: NotificationCenter;
  terminalView: TerminalView;
}>;

function acceptsOnlyPublicPorts(ports: PublicPorts): PublicPorts {
  return ports;
}

function unavailable(policyVersion: PolicyVersion): InformationOutcome<never> {
  return {
    status: "unavailable",
    reason: "api_required",
    requiredCapability: "provider_connection",
    configurationRoute: "/settings/providers",
    policyVersion,
  };
}

void acceptsOnlyPublicPorts;
void unavailable;
process.stdout.write("public seam example passed\n");
