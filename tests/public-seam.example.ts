// COMPILE-TIME FIXTURE, not a runnable gate, and a NARROW one — measured, not assumed.
//
// What it pins: that `src/shared` still exports each public port NAME. Deleting one fails
// `npm run typecheck` (verified 2026-07-26: TS2305 — an earlier comment here claimed TS2724,
// which is the rename/"did you mean" variant, not what a plain deletion produces).
// What it does NOT pin: the ports' SHAPES. Nothing here implements them, so changing
// a method signature in module-interfaces.ts is NOT caught (verified: typecheck stays
// green). Do not read this file as a contract test.
//
// Every import is `import type`, so executing it loads nothing and proves nothing: the
// npm scripts that "ran" these printed "passed" even with the imported module rigged to
// throw, and were removed 2026-07-26 (see scripts/gates/gate-ledger.txt). `tsc` covers
// both files, which is where the remaining value lives.
//
// The list below is the LIVE port set, not the spec's. Five ports whose modules were
// deleted (ResearchAssistant, NotificationCenter, ActualPortfolio, Identity, PaperTrading)
// were removed from the catalog 2026-07-26 — see
// .scratch/financial-terminal/progress/stage3-prep-port-catalog.md.
import type {
  FinancialInformation,
  InformationOutcome,
  PolicyVersion,
  ProviderConnections,
  TerminalView,
} from "../src/shared";

type PublicPorts = Readonly<{
  financialInformation: FinancialInformation;
  providerConnections: ProviderConnections;
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
