import { notFound } from "next/navigation";

import { brandReference } from "@/shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";

import { ActualJournal } from "@/modules/actual-portfolio/baseline/journal";
import { ActualPortfolioService } from "@/modules/actual-portfolio/baseline/portfolio-load";
import type { ActualAccountReference, ActualPortfolioCommand, OpeningPosition } from "@/modules/actual-portfolio/baseline/contracts";
import type { ActualPriceFxPort, PositionsSection } from "@/modules/actual-portfolio/baseline/valuation";

export const dynamic = "force-dynamic";

// Synthetic acceptance surface for F6 (UF-06 / AT-06 baseline / WS-06). Runs
// the REAL journal, corrections, service and completeness presentation over
// scripted price/FX ports so the browser asserts the no-promotion invariant
// against actual DOM. Contained to non-production, SYNTHETIC data only.
function devOnly(): void {
  if (process.env.APP_ENVIRONMENT === "production") notFound();
}

const NOW = "2026-07-17T06:00:00.000Z";
const ACCOUNT = brandReference<string, "ActualAccountReference">("actual-account:demo") as ActualAccountReference;

function viewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-f6-demo",
    workspaceReference: brandReference<string, "WorkspaceReference">("workspace:w-demo"),
    accountReference: brandReference<string, "AccountReference">("account:a-demo"),
    sessionReference: brandReference<string, "SessionReference">("session:s-demo"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
  };
}

function opening(symbol: string, quantity: number, currency: string): OpeningPosition {
  return {
    instrument: brandReference<string, "ActualInstrumentReference">(`instr:${symbol}`),
    signedQuantity: quantity,
    currency,
    asOf: "2026-07-01",
    source: brandReference<string, "ActualSourceReference">(`source:manual:${symbol}`),
    sourceCostBasis: { amount: quantity * 100, currency, includesFees: false },
  };
}

function command(symbol: string, quantity: number, currency = "KRW"): ActualPortfolioCommand {
  return { kind: "record_opening_position", account: ACCOUNT, position: opening(symbol, quantity, currency) };
}

const PRICES: Record<string, { amount: number; currency: string }> = {
  "instr:SSNLF": { amount: 70_000, currency: "KRW" },
  "instr:KODEX": { amount: 10_000, currency: "KRW" },
  "instr:AAPL": { amount: 200, currency: "USD" },
};

function scriptedPort(overrides: { missingPrice?: string[]; missingFx?: boolean } = {}): ActualPriceFxPort {
  return {
    quote(instrument) {
      const key = String(instrument);
      if (overrides.missingPrice?.includes(key)) return { available: false };
      const price = PRICES[key];
      return price === undefined ? { available: false } : { available: true, unitPrice: price, asOf: NOW };
    },
    fxRate(from, to) {
      if (from === to) return { available: true, rate: 1, asOf: NOW };
      if (overrides.missingFx === true) return { available: false };
      if (from === "USD" && to === "KRW") return { available: true, rate: 1_400, asOf: NOW };
      return { available: false };
    },
  };
}

async function buildScenarios() {
  const journal = new ActualJournal(() => NOW);
  const workspace = "workspace:w-demo";
  const first = journal.append(workspace, command("SSNLF", 10), { idempotencyKey: "k1", expectedRevision: "0" });
  journal.append(workspace, command("KODEX", 30), { idempotencyKey: "k2", expectedRevision: "1" });
  journal.append(workspace, command("AAPL", 10, "USD"), { idempotencyKey: "k3", expectedRevision: "2" });
  // Correction demo: the SSNLF aggregate lot was entered as 10, superseded to 12.
  if (first.status === "applied") {
    journal.append(workspace, {
      kind: "supersede_entry",
      account: ACCOUNT,
      target: first.entryReference,
      replacement: { kind: "opening_position", position: opening("SSNLF", 12, "KRW") },
    }, { idempotencyKey: "k4", expectedRevision: "3" });
  }

  const openWith = async (port: ActualPriceFxPort): Promise<PositionsSection | undefined> => {
    const service = new ActualPortfolioService({
      journal,
      port,
      identity: { currentAuthorizationEpoch: () => "epoch:1" },
      policyVersion: "policy:f6-demo",
      now: () => NOW,
      updateId: () => "update:demo",
    });
    const load = service.open({ sections: ["positions", "valuation"], requestRevision: "r-demo" }, viewer());
    const update = await load.refresh("valuation");
    return update?.section;
  };

  return {
    complete: await openWith(scriptedPort()),
    partial: await openWith(scriptedPort({ missingPrice: ["instr:KODEX"] })),
    unavailable: await openWith(scriptedPort({ missingPrice: ["instr:SSNLF", "instr:KODEX"], missingFx: true })),
  };
}

const KRW = new Intl.NumberFormat("ko-KR");

function money(value: { amount: number; currency: string }): string {
  return `${KRW.format(value.amount)} ${value.currency}`;
}

function SectionView({ title, section }: { title: string; section: PositionsSection | undefined }) {
  if (section === undefined) return null;
  return (
    <section aria-label={title} data-completeness={section.completeness} style={{ border: "1px solid #465052", margin: "8px 0", padding: "8px" }}>
      <h2 style={{ fontSize: "1rem", margin: "0 0 4px" }}>{title}</h2>
      <p data-role="completeness-label">
        {section.completeness === "complete" ? "완전" : section.completeness === "partial" ? "부분(알려진 소계만)" : "평가 불가"}
      </p>
      {section.completeness === "complete" ? <p data-role="total">합계 {money(section.total)}</p> : null}
      {section.completeness === "partial" ? <p data-role="known-subtotal">알려진 소계 {money(section.knownSubtotal)}</p> : null}
      {section.completeness !== "complete" && section.missing.length > 0 ? (
        <ul data-role="missing-list" aria-label={`${title} 누락 목록`}>
          {section.missing.map((gap) => (
            <li key={gap.instrument} data-missing-reason={gap.reason}>
              {gap.instrument} · {gap.reason === "price" ? "가격 없음" : "환율 없음"}
            </li>
          ))}
        </ul>
      ) : null}
      <ul aria-label={`${title} 보유 목록`}>
        {section.rows.map((row) => (
          <li key={row.instrument} data-row-instrument={row.instrument} data-aggregate-lot={row.aggregateLot}>
            <span>{row.instrument}</span>
            <span> · 수량 {row.signedQuantity}</span>
            {row.aggregateLot ? <strong data-role="aggregate-lot-label"> · 합산 lot({row.asOf} 기준)</strong> : null}
            {row.originalValue ? <span data-role="original-value"> · 원통화 {money(row.originalValue)}</span> : null}
            {"weight" in row ? <span data-role="weight"> · 비중 {(row.weight * 100).toFixed(1)}%</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function F6PortfolioPage() {
  devOnly();
  const scenarios = await buildScenarios();

  return (
    <main style={{ padding: "12px", boxSizing: "border-box" }} aria-label="F6 Actual Portfolio baseline" data-surface="f6-portfolio">
      <div role="note" data-role="synthetic-marker">
        <strong>SYNTHETIC TEST DATA</strong>
        <span> · INTERNAL TEST ONLY · 실제 자산 아님</span>
      </div>
      <SectionView title="완전 평가 시나리오" section={scenarios.complete} />
      <SectionView title="부분 평가 시나리오" section={scenarios.partial} />
      <SectionView title="평가 불가 시나리오" section={scenarios.unavailable} />
    </main>
  );
}
