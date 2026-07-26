// COMPILE-TIME FIXTURE, not a runnable gate, and a NARROW one — measured, not assumed.
//
// What it pins: that `src/shared` still exports each public port NAME. Renaming or
// deleting one fails `npm run typecheck` (verified: TS2724).
// What it does NOT pin: the ports' SHAPES. Nothing here implements them, so changing
// a method signature in module-interfaces.ts is NOT caught (verified: typecheck stays
// green). Do not read this file as a contract test.
//
// Every import is `import type`, so executing it loads nothing and proves nothing: the
// npm scripts that "ran" these printed "passed" even with the imported module rigged to
// throw, and were removed 2026-07-26 (see scripts/gates/gate-ledger.txt). `tsc` covers
// both files, which is where the remaining value lives.
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
