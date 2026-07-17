import { notFound } from "next/navigation";

import { brandReference } from "@/shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";

import { PaperTradingService } from "@/modules/paper-trading/internal/service";
import { InternalPaperSimulator, SIMULATION_V1 } from "@/modules/paper-trading/internal/simulator";
import { PaperLifecycleIngestion } from "@/modules/paper-trading/internal/lifecycle";
import { presentBlotter } from "@/modules/paper-trading/internal/blotter";
import type { PaperBlotterRow } from "@/modules/paper-trading/internal/blotter";
import type { PaperInitialShell } from "@/modules/paper-trading/internal/service";
import type {
  PaperCorporateActionReference,
  PaperInstrumentReference,
  PaperMarketObservation,
  PaperOrderPayload,
} from "@/modules/paper-trading/internal/contracts";

export const dynamic = "force-dynamic";

// Synthetic acceptance surface for F8 (UF-07 / AT-07 / WS-06). Runs the REAL
// journal, intent flow, simulator, lifecycle ingestion and Blotter
// presentation over scripted observations so the browser asserts the Paper
// identification and three-axis states against actual DOM. Contained to
// non-production, SYNTHETIC data only.
function devOnly(): void {
  if (process.env.APP_ENVIRONMENT === "production") notFound();
}

const WORKSPACE = "workspace:w-f8-demo";
const AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL") as PaperInstrumentReference;

function viewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-f8-demo",
    workspaceReference: brandReference<string, "WorkspaceReference">(WORKSPACE),
    accountReference: brandReference<string, "AccountReference">("account:a-demo"),
    sessionReference: brandReference<string, "SessionReference">("session:s-demo"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
  };
}

function limitBuy(quantity: number, limit: number, timeInForce: "DAY" | "GTC"): PaperOrderPayload {
  return {
    instrument: AAPL,
    venue: "XNAS",
    session: "regular",
    side: "buy",
    orderType: "limit",
    limitPrice: { amount: limit, currency: "USD" },
    quantity,
    timeInForce,
  };
}

function observation(overrides?: Partial<PaperMarketObservation>): PaperMarketObservation {
  return {
    instrument: AAPL,
    venue: "XNAS",
    session: "regular",
    price: { amount: 100, currency: "USD" },
    volume: 100,
    eventTime: "2026-07-18T02:01:00.000Z",
    receivedAt: "2026-07-18T02:01:01.000Z",
    dataClock: "2026-07-18T02:01:00.000Z",
    freshness: "realtime",
    evidenceReference: "evidence:demo-1",
    ...overrides,
  };
}

async function buildScenario(): Promise<{ shell: PaperInitialShell; blotter: readonly PaperBlotterRow[] }> {
  const clock = { value: "2026-07-18T02:00:00.000Z" };
  let updateCounter = 0;
  const service = new PaperTradingService({
    now: () => clock.value,
    identity: { currentAuthorizationEpoch: () => "epoch:1" },
    observations: { currentObservation: () => undefined },
    policy: {
      policyVersion: "simulation-v1",
      seedCash: [{ amount: 100_000, currency: "USD" }],
      intentTtlMs: 600_000,
      maxSlippageBps: 25,
    },
    updateId: () => `update:${updateCounter += 1}`,
  });
  const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
  const lifecycle = new PaperLifecycleIngestion({ journal: service.journal });

  const submit = async (payload: PaperOrderPayload, key: string) => {
    const prepared = await service.prepare({ payload }, viewer());
    if (prepared.status !== "issued") throw new Error(`prepare failed: ${prepared.status}`);
    const outcome = service.change(
      { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
      { idempotencyKey: key, expectedRevision: String(prepared.intent.accountRevision) },
      viewer(),
    );
    if (outcome.status !== "applied") throw new Error(`submit failed: ${outcome.status}`);
    return { order: outcome.order, account: prepared.intent.account };
  };

  // GTC 25 @ $110 → 10 filled @ $100.07 (full 10% of 100 volume, 7 bps).
  const gtc = await submit(limitBuy(25, 110, "GTC"), "demo-gtc");
  // DAY 4 @ $120 — expires on the next-day observation.
  await submit(limitBuy(4, 120, "DAY"), "demo-day");
  simulator.ingest(WORKSPACE, gtc.account, observation());
  clock.value = "2026-07-18T02:05:00.000Z";
  service.change({ kind: "cancel", account: gtc.account, order: gtc.order }, { idempotencyKey: "demo-cxl", expectedRevision: "4" }, viewer());
  simulator.ingest(WORKSPACE, gtc.account, observation({
    eventTime: "2026-07-19T14:30:00.000Z",
    dataClock: "2026-07-19T14:30:00.000Z",
    receivedAt: "2026-07-19T14:30:01.000Z",
    evidenceReference: "evidence:demo-next-day",
  }));
  lifecycle.applySplit(WORKSPACE, gtc.account, {
    action: brandReference<string, "PaperCorporateActionReference">("action:demo-split") as PaperCorporateActionReference,
    instrument: AAPL,
    numerator: 2,
    denominator: 1,
  });
  lifecycle.applyDividend(WORKSPACE, gtc.account, {
    action: brandReference<string, "PaperCorporateActionReference">("action:demo-div") as PaperCorporateActionReference,
    instrument: AAPL,
    perShare: { amount: 0.5, currency: "USD" },
  });

  const shell = await service.open({ requestRevision: "r-demo" }, viewer()).initial;
  return { shell, blotter: presentBlotter(service.journal.list(WORKSPACE, gtc.account)) };
}

const USD = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const KIND_LABEL: Record<PaperBlotterRow["kind"], string> = {
  submit: "제출",
  fill: "모의 체결",
  cancel_confirmed: "취소 확인",
  cancel_rejected: "취소 거절",
  expiry: "만료",
  corporate_action: "기업행동",
  dividend: "배당",
};

export default async function F8PaperPage() {
  devOnly();
  const { shell, blotter } = await buildScenario();
  if (shell.status !== "ready") throw new Error("demo shell failed");

  return (
    <main style={{ padding: "12px", boxSizing: "border-box" }} aria-label="F8 Internal Paper Trading" data-surface="f8-paper">
      <div role="note" data-role="synthetic-marker">
        <strong>SYNTHETIC TEST DATA</strong>
        <span> · INTERNAL TEST ONLY · 실제 자산 아님</span>
      </div>
      <p
        data-role="paper-badge"
        style={{ background: "#f5c518", color: "#1a1a1a", display: "inline-block", padding: "2px 8px", fontWeight: 700 }}
      >
        PAPER TRADING · 모의 거래 · Internal Paper Account
      </p>
      <p data-role="account-source">계좌 출처: {String(shell.account)}</p>

      <section aria-label="Paper 현금" data-role="cash-section">
        <h2 style={{ fontSize: "1rem", margin: "8px 0 4px" }}>현금</h2>
        <ul>
          {shell.cash.map((row) => (
            <li key={row.currency} data-cash-currency={row.currency}>
              <span data-role="cash-balance">잔액 {USD.format(row.balance)} {row.currency}</span>
              <span data-role="cash-reserved"> · 예약 {USD.format(row.reserved)}</span>
              <span data-role="cash-available"> · 가용 {USD.format(row.available)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Paper 보유" data-role="positions-section">
        <h2 style={{ fontSize: "1rem", margin: "8px 0 4px" }}>보유(모의)</h2>
        <ul>
          {shell.positions.map((row) => (
            <li key={String(row.instrument)} data-position-instrument={String(row.instrument)}>
              <span>{String(row.instrument)}</span>
              <span data-role="position-quantity"> · 수량 {row.quantity}</span>
              <span data-role="position-basis"> · 원가 {USD.format(row.costBasis.amount)} {row.costBasis.currency}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Paper 주문" data-role="orders-section">
        <h2 style={{ fontSize: "1rem", margin: "8px 0 4px" }}>주문 상태(세 축)</h2>
        <ul>
          {shell.orders.map((order) => (
            <li key={String(order.order)} data-order={String(order.order)} data-execution={order.execution} data-cancellation={order.cancellation}>
              <span>{order.payload.side} {order.payload.quantity} {String(order.payload.instrument)}</span>
              <span data-role="axis-submission"> · 접수 {order.submission}</span>
              <span data-role="axis-execution"> · 체결 {order.execution}</span>
              <span data-role="axis-cancellation"> · 취소 {order.cancellation}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Paper Blotter" data-role="blotter-section">
        <h2 style={{ fontSize: "1rem", margin: "8px 0 4px" }}>Paper Blotter</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">시각</th>
              <th scope="col">구분</th>
              <th scope="col">내용</th>
              <th scope="col">체결 시각/수신 시각</th>
            </tr>
          </thead>
          <tbody>
            {blotter.map((row) => (
              <tr key={`${row.revision}`} data-role="blotter-row" data-kind={row.kind}>
                <td>{row.at}</td>
                <td data-role="blotter-kind">{KIND_LABEL[row.kind]}</td>
                <td data-role="blotter-detail">{row.detail}</td>
                <td data-role="blotter-times">{row.kind === "fill" ? `${row.eventTime} / ${row.receivedAt}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
