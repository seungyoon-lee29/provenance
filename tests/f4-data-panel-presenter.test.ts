import { describe, expect, it } from "vitest";

import { catalogClock, createScriptedMarketInformation, loadSyntheticMarketCatalog } from "../src/modules/financial-information/data/scripted-market-information";
import { createScriptedEvidenceResolver, loadSyntheticEvidenceCatalog } from "../src/modules/financial-information/data/scripted-evidence-resolver";
import { presentEvidencePanel, presentMarketPanel, presentResearchPanel } from "../src/modules/terminal-view/presentation/data/data-panel-presenter";
import { createResearchAssistant } from "../src/modules/research-assistant/research-service";
import { envelopeById, RecordingGeminiAdapter, RecordingLocalRule, scriptedMaterialResolver, staticConsent, consentEpoch } from "../src/modules/research-assistant/scripted-research";
import type { AiMaterialOutcome, ResearchTaskShape } from "../src/modules/research-assistant/contracts";
import type { EvidenceReference, InformationOutcome } from "@/shared";
import type { EvidenceValue } from "../src/modules/financial-information/data/evidence-contracts";
import type { MarketQuery } from "../src/modules/financial-information/data/contracts";
import type { ViewerContext, WorkspaceViewerContext } from "@/shared/contracts/viewer-context";

const guest: ViewerContext = { kind: "guest", requestId: "req-present" };

function query(symbol: string): MarketQuery {
  return { kind: "FinancialQuery", symbol, purpose: "public_display", requestRevision: "r0" };
}

describe("AT-01 DOM invariant via the reused outcome presenter (bullet 1: API AND DOM match)", () => {
  const provider = createScriptedMarketInformation(catalogClock());
  const catalog = loadSyntheticMarketCatalog();

  for (const entry of catalog.cases) {
    it(`renders ${entry.id}: primaryValue present iff available`, async () => {
      const outcome = await provider.read(query(entry.symbol), guest).result;
      const view = presentMarketPanel(outcome);
      if (outcome.status === "available") {
        expect(view.tone).toBe("available");
        expect(view.primaryValue).toBeDefined();
        expect(view.provenance.some((p) => p.label === "Provider")).toBe(true);
      } else {
        expect(view.primaryValue).toBeUndefined();
        expect(view.tone === "failed" || view.tone === "notice").toBe(true);
      }
    });
  }

  it("stale value renders with the value AND a degradation/retry notice", async () => {
    const outcome = await provider.read(query("STL"), guest).result;
    const view = presentMarketPanel(outcome);
    expect(view.primaryValue).toBeDefined();
    expect(view.statusLabel).toBe("오래됨");
    expect(view.provenance.some((p) => p.label === "Degradation code")).toBe(true);
  });

  it("failed and unavailable never render a value", async () => {
    for (const symbol of ["TMO", "R401", "APIR", "LICR", "NOD", "HRD", "MAL"]) {
      const outcome = await provider.read(query(symbol), guest).result;
      expect(presentMarketPanel(outcome).primaryValue).toBeUndefined();
    }
  });
});

describe("evidence panel reuses the same invariant", () => {
  const resolver = createScriptedEvidenceResolver();
  const evCatalog = loadSyntheticEvidenceCatalog();
  for (const entry of evCatalog.cases) {
    it(`renders evidence ${entry.id}`, async () => {
      const outcome = (await resolver.resolve(entry.reference as EvidenceReference, entry.purpose, guest)) as InformationOutcome<EvidenceValue>;
      const view = presentEvidencePanel(outcome);
      expect(view.primaryValue !== undefined).toBe(outcome.status === "available");
    });
  }
});

describe("research panel reuses the same invariant", () => {
  const viewer: WorkspaceViewerContext = {
    kind: "workspace", requestId: "r1",
    workspaceReference: "workspace:w1" as never, accountReference: "account:a1" as never, sessionReference: "session:s1" as never,
    sessionGeneration: "gen:1" as never, accountAuthorizationEpoch: "authz:e1" as never, membershipRevision: "mem:1" as never,
  };
  const GRANTED = { granted: true, allowsExternalProcessing: true, epoch: consentEpoch("consent:c1") };
  const task: ResearchTaskShape = { kind: "ResearchTask", instruction: "Summarize.", mode: "summarize" };

  it("available research renders a value; denied renders none", async () => {
    const env = envelopeById("mat_full");
    const map = new Map<string, AiMaterialOutcome>([[env.reference, { status: "available", value: env }]]);
    const svc = createResearchAssistant({ materialResolver: scriptedMaterialResolver(map), consentResolver: staticConsent(GRANTED), adapter: new RecordingGeminiAdapter(true), localRule: new RecordingLocalRule(), now: () => 1_700_000_000_000 });
    const ok = await svc.run(task, [env.reference], viewer);
    expect(presentResearchPanel(ok).primaryValue).toBeDefined();

    const denied = await svc.run(task, [], viewer);
    expect(presentResearchPanel(denied).primaryValue).toBeUndefined();
  });
});
