import { notFound } from "next/navigation";

import type { InformationOutcome } from "@/shared";
import type { ViewerContext, WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import type { EvidenceReference } from "@/shared";

import type { MarketObservation, MarketQuery } from "@/modules/financial-information/data/contracts";
import {
  catalogClock,
  createScriptedMarketInformation,
  loadSyntheticMarketCatalog,
} from "@/modules/financial-information/data/scripted-market-information";
import {
  createScriptedEvidenceResolver,
  loadSyntheticEvidenceCatalog,
} from "@/modules/financial-information/data/scripted-evidence-resolver";
import { AI_DEADLINE_MS, DATA_DEADLINE_MS, deadlineTimeoutOutcome, withDeadline } from "@/modules/financial-information/data/deadline";
import { createResearchAssistant } from "@/modules/research-assistant/research-service";
import type { AiMaterialOutcome, ResearchTaskShape } from "@/modules/research-assistant/contracts";
import {
  consentEpoch,
  envelopeById,
  RecordingGeminiAdapter,
  RecordingLocalRule,
  scriptedMaterialResolver,
  staticConsent,
} from "@/modules/research-assistant/scripted-research";
import { GuestPanel } from "@/modules/terminal-view/presentation/guest/guest-panel";
import {
  toEvidencePanelState,
  toMarketPanelState,
  toResearchPanelState,
} from "@/modules/terminal-view/presentation/data/data-panel-presenter";

export const dynamic = "force-dynamic";

// Synthetic acceptance surface for F4 (AT-01/AT-04). Renders the reviewed literal
// catalogs through the real freshness/error/deadline machine and the F1-proven
// GuestPanel, so the "API AND DOM match" invariant is checked in a real browser.
// Contained to non-production (network-off scripted lane, SYNTHETIC data only).
function devOnly(): void {
  if (process.env.APP_ENVIRONMENT === "production") notFound();
}

const guest: ViewerContext = { kind: "guest", requestId: "req-f4-panels" };

const workspaceViewer: WorkspaceViewerContext = {
  kind: "workspace",
  requestId: "req-f4-research",
  workspaceReference: "workspace:w-demo" as never,
  accountReference: "account:a-demo" as never,
  sessionReference: "session:s-demo" as never,
  sessionGeneration: "gen:1" as never,
  accountAuthorizationEpoch: "authz:e1" as never,
  membershipRevision: "mem:1" as never,
};

function marketQuery(symbol: string): MarketQuery {
  return { kind: "FinancialQuery", symbol, purpose: "public_display", requestRevision: "r0" };
}

async function loadMarketMatrix() {
  const clock = catalogClock();
  const provider = createScriptedMarketInformation(clock);
  const catalog = loadSyntheticMarketCatalog();
  const occurredAt = new Date(clock.now()).toISOString();
  return Promise.all(
    catalog.cases.map(async (entry) => {
      const load = provider.read(marketQuery(entry.symbol), guest);
      const outcome = await withDeadline(load.result, {
        deadlineMs: DATA_DEADLINE_MS,
        sleep: clock.sleep,
        onTimeout: () => deadlineTimeoutOutcome<MarketObservation>("synthetic", entry.symbol, occurredAt),
      });
      return { id: entry.id, title: `${entry.symbol} · ${entry.id}`, state: toMarketPanelState(entry.id, outcome) };
    }),
  );
}

async function loadDeadlineDemo() {
  const clock = catalogClock();
  const occurredAt = new Date(clock.now()).toISOString();
  // A read that never settles from the feed → the deadline must resolve it to a
  // normalized timeout so the panel shows an outcome, never an infinite spinner.
  const hanging = new Promise<InformationOutcome<MarketObservation>>(() => {});
  // ponytail: 400ms demo deadline so the browser observes the timeout fast;
  // production feeds use DATA_DEADLINE_MS (10s) / AI_DEADLINE_MS (20s).
  const outcome = await withDeadline(hanging, {
    deadlineMs: 400,
    sleep: clock.sleep,
    onTimeout: () => deadlineTimeoutOutcome<MarketObservation>("synthetic", "deadline-demo", occurredAt),
  });
  return { id: "deadline-demo", title: "Deadline demo · never settles", state: toMarketPanelState("deadline-demo", outcome) };
}

async function loadEvidence() {
  const resolver = createScriptedEvidenceResolver();
  const catalog = loadSyntheticEvidenceCatalog();
  return Promise.all(
    catalog.cases.map(async (entry) => {
      const outcome = await resolver.resolve(entry.reference as EvidenceReference, entry.purpose, guest);
      return { id: `ev-${entry.id}`, title: `Evidence · ${entry.id}`, state: toEvidencePanelState(`ev-${entry.id}`, outcome) };
    }),
  );
}

async function loadResearch() {
  const full = envelopeById("mat_full");
  const svc = createResearchAssistant({
    materialResolver: scriptedMaterialResolver(new Map<string, AiMaterialOutcome>([[full.reference, { status: "available", value: full }]])),
    consentResolver: staticConsent({ granted: true, allowsExternalProcessing: true, epoch: consentEpoch("consent:c1") }),
    adapter: new RecordingGeminiAdapter(true),
    localRule: new RecordingLocalRule(),
    now: () => 1_700_000_000_000,
  });
  const task: ResearchTaskShape = { kind: "ResearchTask", instruction: "Summarize.", mode: "summarize" };
  const [available, denied] = await Promise.all([
    withDeadline(svc.run(task, [full.reference], workspaceViewer), {
      deadlineMs: AI_DEADLINE_MS,
      sleep: catalogClock().sleep,
      onTimeout: () => deadlineTimeoutOutcome("gemini", "research", "2026-01-02T14:30:20.000Z"),
    }),
    svc.run(task, [], workspaceViewer),
  ]);
  return [
    { id: "research-ok", title: "Research · available", state: toResearchPanelState("research-ok", available) },
    { id: "research-denied", title: "Research · no material", state: toResearchPanelState("research-denied", denied) },
  ];
}

export default async function F4PanelsPage() {
  devOnly();
  const [market, deadlineDemo, evidence, research] = await Promise.all([
    loadMarketMatrix(),
    loadDeadlineDemo(),
    loadEvidence(),
    loadResearch(),
  ]);
  const marketPanels = [...market, deadlineDemo];

  return (
    <main style={{ padding: "12px", boxSizing: "border-box" }} aria-label="F4 정보 outcome 매트릭스" data-surface="f4-panels">
      <div role="note" data-role="synthetic-marker">
        <strong>SYNTHETIC TEST DATA</strong>
        <span> · INTERNAL TEST ONLY · 실제 시장 데이터 아님</span>
      </div>

      <section aria-label="시장 관측 매트릭스" data-group="market">
        {marketPanels.map((panel) => (
          <GuestPanel key={panel.id} title={panel.title} state={panel.state} />
        ))}
      </section>

      <section aria-label="Evidence 매트릭스" data-group="evidence">
        {evidence.map((panel) => (
          <GuestPanel key={panel.id} title={panel.title} state={panel.state} />
        ))}
      </section>

      <section aria-label="Research 매트릭스" data-group="research">
        {research.map((panel) => (
          <GuestPanel key={panel.id} title={panel.title} state={panel.state} />
        ))}
      </section>
    </main>
  );
}
