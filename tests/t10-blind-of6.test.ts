import { describe, expect, it } from "vitest";
import { brandReference } from "../src/shared/contracts/brands";
import type { InternalPaperAccountReference } from "../src/shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import { PaperTradingService } from "../src/modules/paper-trading/internal/service";
import { InternalPaperSimulator, SIMULATION_V1 } from "../src/modules/paper-trading/internal/simulator";
import type {
  PaperInstrumentReference,
  PaperMarketObservation,
  PaperMoney,
  PaperOrderPayload,
} from "../src/modules/paper-trading/internal/contracts";

/**
 * OF-6 blind suite (v2) — 분할이 살아있는 주문의 예약을 다시 쓸 때의 천장.
 *
 * 계약: `.scratch/honesty-and-gates/blind-contract-of6.md` 뿐이다.
 * 구현(journal.ts)은 열지 않았다.
 *
 * v1 의 "예약 가치 정확 보존"은 폐기됐다. v2 는 두 가지만 요구한다:
 *  - 예약 단가는 올림(ceil), 지정가는 반올림 → 예약은 모자라지지 않는다.
 *  - 통화별 합계 `reserved > balance` 면 `reservation_exceeds_balance`.
 */

const NOW = "2026-07-18T02:00:00.000Z";
const WORKSPACE = "workspace:a";
const AAPL = brandReference<string, "PaperInstrumentReference">("instr:AAPL") as PaperInstrumentReference;
const MSFT = brandReference<string, "PaperInstrumentReference">("instr:MSFT") as PaperInstrumentReference;

function viewer(): WorkspaceViewerContext {
  return {
    kind: "workspace", requestId: "req-1",
    workspaceReference: brandReference<string, "WorkspaceReference">(WORKSPACE),
    accountReference: brandReference<string, "AccountReference">("account:a"),
    sessionReference: brandReference<string, "SessionReference">("session:a"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
  };
}

function limitBuy(quantity: number, limit: number, instrument: PaperInstrumentReference = AAPL): PaperOrderPayload {
  return { instrument, venue: "XNAS", session: "regular", side: "buy", orderType: "limit",
    limitPrice: { amount: limit, currency: "USD" }, quantity, timeInForce: "GTC" };
}

function limitSell(quantity: number, limit: number): PaperOrderPayload {
  return { instrument: AAPL, venue: "XNAS", session: "regular", side: "sell", orderType: "limit",
    limitPrice: { amount: limit, currency: "USD" }, quantity, timeInForce: "GTC" };
}

function marketBuy(quantity: number): PaperOrderPayload {
  return { instrument: AAPL, venue: "XNAS", session: "regular", side: "buy", orderType: "market",
    quantity, timeInForce: "GTC" };
}

function observation(overrides?: Partial<PaperMarketObservation>): PaperMarketObservation {
  return { instrument: AAPL, venue: "XNAS", session: "regular", price: { amount: 100, currency: "USD" },
    volume: 100, eventTime: "2026-07-18T02:01:00.000Z", receivedAt: "2026-07-18T02:01:01.000Z",
    dataClock: "2026-07-18T02:01:00.000Z", freshness: "realtime", evidenceReference: "evidence:obs-1", ...overrides };
}

function harness(
  options?: Readonly<{ quote?: PaperMarketObservation; seedCash?: readonly PaperMoney[] }>,
) {
  const nowRef = { value: NOW };
  let updateCounter = 0;
  const service = new PaperTradingService({
    now: () => nowRef.value,
    identity: { currentAuthorizationEpoch: () => "epoch:1" },
    observations: { currentObservation: () => options?.quote },
    policy: {
      policyVersion: "simulation-v1",
      seedCash: options?.seedCash ?? [{ amount: 100_000, currency: "USD" }],
      intentTtlMs: 600_000,
      maxSlippageBps: 25,
    },
    updateId: () => `update:${updateCounter += 1}`,
  });
  const simulator = new InternalPaperSimulator({ journal: service.journal, policy: SIMULATION_V1 });
  return { service, simulator, nowRef };
}

async function submit(service: PaperTradingService, payload: PaperOrderPayload, key: string) {
  const prepared = await service.prepare({ payload }, viewer());
  if (prepared.status !== "issued") throw new Error(`prepare failed: ${prepared.status}`);
  const outcome = await service.change(
    { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
    { idempotencyKey: key, expectedRevision: String(prepared.intent.accountRevision) },
    viewer(),
  );
  if (outcome.status !== "applied") throw new Error(`submit failed: ${outcome.status}`);
  return { order: outcome.order, account: prepared.intent.account };
}

async function shellOf(service: PaperTradingService) {
  const shell = await service.open({ requestRevision: "read" }, viewer()).initial;
  if (shell.status !== "ready") throw new Error("open failed");
  return shell;
}

let actionCounter = 0;
async function applySplit(
  service: PaperTradingService,
  account: InternalPaperAccountReference,
  numerator: number,
  denominator: number,
  instrument: PaperInstrumentReference = AAPL,
) {
  actionCounter += 1;
  return service.journal.appendSystem(WORKSPACE, account, `split-key:${actionCounter}`, {
    kind: "corporate_action_applied",
    action: brandReference<string, "PaperCorporateActionReference">(`action:${actionCounter}`) as never,
    instrument,
    adjustment: { kind: "split", numerator, denominator },
  });
}

function usd(shell: Awaited<ReturnType<typeof shellOf>>) {
  const row = shell.cash.find((entry) => entry.currency === "USD");
  if (row === undefined) throw new Error("no USD row");
  return row;
}

function only(shell: Awaited<ReturnType<typeof shellOf>>) {
  expect(shell.orders).toHaveLength(1);
  return shell.orders[0]!;
}

function orderFor(shell: Awaited<ReturnType<typeof shellOf>>, instrument: PaperInstrumentReference) {
  const found = shell.orders.find((order) => String(order.payload.instrument) === String(instrument));
  if (found === undefined) throw new Error(`no order for ${String(instrument)}`);
  return found;
}

describe("OF-6 · 예약 단가는 올림 — 홀수 센트가 분할을 막지 않는다", () => {
  it("100주 @ $101.03 의 2:1 분할은 통과하고, 예약은 올림 나머지만큼만 는다", async () => {
    // 겨눌 것 1. v1 은 여기서 "보존이 깨졌다"며 거절했다 — 2:1 의 50% 가 이 경우다.
    const { service } = harness();
    const { account } = await submit(service, limitBuy(100, 101.03), "key:odd-cent");

    const before = usd(await shellOf(service));
    expect(before.reserved).toBeCloseTo(10_103, 10);

    const outcome = await applySplit(service, account, 2, 1);
    expect(outcome.status).toBe("applied");

    const after = await shellOf(service);
    // 예약 단가: ceil(10103/2) = 5052 minor = $50.52 → 200주 × $50.52 = $10,104.
    // 주당 0.5¢(< 1 minor)만 더 잡았고, 그 증가분은 공개 숫자 reserved 에 그대로 보인다.
    expect(usd(after).reserved).toBeCloseTo(10_104, 10);
    expect(usd(after).balance).toBe(before.balance);
    expect(usd(after).reserved).toBeLessThanOrEqual(usd(after).balance);
    // 지정가는 반올림: round(5051.5) = 5052 minor = $50.52.
    expect(only(after).payload.quantity).toBe(200);
    expect(only(after).payload.limitPrice?.amount).toBeCloseTo(50.52, 10);
  });

  it("짝수 센트(5주 @ $110, 2:1)는 올림 나머지가 0이라 예약이 그대로다", async () => {
    // 겨눌 것 2.
    const { service } = harness();
    const { account } = await submit(service, limitBuy(5, 110), "key:even-cent");

    const before = usd(await shellOf(service));
    expect(before.reserved).toBe(550);

    const outcome = await applySplit(service, account, 2, 1);
    expect(outcome.status).toBe("applied");

    const after = await shellOf(service);
    expect(usd(after).reserved).toBe(550);
    expect(usd(after).balance).toBe(before.balance);
    expect(only(after).payload.quantity).toBe(10);
    expect(only(after).payload.limitPrice?.amount).toBe(55);
  });
});

describe("OF-6 · 현금 천장 — 합계 reserved 가 balance 를 넘으면 거부", () => {
  it("양성 대조군: 같은 분할도 다른 주문이 잔고를 덜 묶고 있으면 통과한다", async () => {
    // 겨눌 것 4 의 대조군. AAPL 주문·분할은 아래 거부 케이스와 글자 그대로 같고,
    // 분할이 건드리지 않는 MSFT 주문의 크기만 다르다.
    const { service } = harness();
    const { account } = await submit(service, limitBuy(9, 11_110, MSFT), "key:ceiling-other-ok");
    await submit(service, limitBuy(3, 0.33), "key:ceiling-target-ok");

    const before = usd(await shellOf(service));
    expect(before.reserved).toBeCloseTo(99_990.99, 10);

    const outcome = await applySplit(service, account, 2, 1);
    expect(outcome.status).toBe("applied");

    const after = await shellOf(service);
    // AAPL: ceil(33/2) = 17 minor → 6주 × $0.17 = $1.02 (분할 전 $0.99).
    expect(usd(after).reserved).toBeCloseTo(99_991.02, 10);
    expect(usd(after).reserved).toBeLessThanOrEqual(usd(after).balance);
    expect(orderFor(after, AAPL).payload.quantity).toBe(6);
    expect(orderFor(after, MSFT).payload.quantity).toBe(9);
  });

  it("천장은 계정 전체다 — 분할이 건드리지 않는 주문의 예약까지 합쳐 판정한다", async () => {
    // 겨눌 것 4. AAPL 의 예약 증가분은 3¢ 뿐이지만, MSFT 가 잔고를 $99,999 묶고
    // 있으므로 합계가 $100,000.02 > $100,000 이 된다. AAPL 주문만 보면 통과다.
    const { service } = harness();
    const { account } = await submit(service, limitBuy(9, 11_111, MSFT), "key:ceiling-other-no");
    await submit(service, limitBuy(3, 0.33), "key:ceiling-target-no");

    const before = usd(await shellOf(service));
    expect(before.reserved).toBeCloseTo(99_999.99, 10);
    expect(before.reserved).toBeLessThanOrEqual(before.balance);

    const outcome = await applySplit(service, account, 2, 1);
    expect(outcome).toMatchObject({ status: "refused", reason: "reservation_exceeds_balance" });

    const after = await shellOf(service);
    expect(usd(after).reserved).toBeCloseTo(99_999.99, 10);
    expect(usd(after).balance).toBe(before.balance);
    expect(orderFor(after, AAPL).payload.quantity).toBe(3);
    expect(orderFor(after, AAPL).payload.limitPrice?.amount).toBeCloseTo(0.33, 10);
  });

  it("폭주가 멈춘다 — 1¢ 지정가 매수에 2:1 을 반복하면 잔고를 넘는 순간 거부된다", async () => {
    // 겨눌 것 3 (원 OF-6 공격). 예약이 두 배씩 자라지만 매 단계에서 reserved ≤ balance
    // 가 유지되고, 넘는 순간 reservation_exceeds_balance 로 멈춰야 한다.
    const { service } = harness();
    const { account } = await submit(service, limitBuy(1, 0.01), "key:runaway");

    let steps = 0;
    let stopped: unknown;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const shell = await shellOf(service);
      expect(usd(shell).reserved).toBeLessThanOrEqual(usd(shell).balance);

      const outcome = await applySplit(service, account, 2, 1);
      if (outcome.status !== "applied") {
        stopped = outcome;
        break;
      }
      steps += 1;
    }

    expect(stopped).toMatchObject({ status: "refused", reason: "reservation_exceeds_balance" });
    // 잔고 $100,000 = 10,000,000¢ 이므로 1¢ 에서 2^24 번째 배가가 처음 넘는다.
    expect(steps).toBe(23);

    const after = await shellOf(service);
    expect(usd(after).reserved).toBeCloseTo(2 ** 23 / 100, 10);
    expect(usd(after).reserved).toBeLessThanOrEqual(usd(after).balance);
    expect(only(after).payload.quantity).toBe(2 ** 23);
  });
});

describe("OF-6 · 1 minor unit 미만 지정가 — fractional_result", () => {
  async function withPosition(quantity: number) {
    const { service, simulator } = harness();
    const { account } = await submit(service, limitBuy(quantity, 110), "key:seed-buy");
    await simulator.ingest(WORKSPACE, account, observation({ volume: quantity * 10 }));
    const shell = await shellOf(service);
    expect(shell.positions[0]?.quantity).toBe(quantity);
    return { service, account };
  }

  it("양성 대조군(매수): 2¢ 지정가 + 2:1 은 1¢ 로 남으므로 통과한다", async () => {
    const { service } = harness();
    const { account } = await submit(service, limitBuy(1, 0.02), "key:frac-buy-ok");

    const outcome = await applySplit(service, account, 2, 1);
    expect(outcome.status).toBe("applied");

    const after = await shellOf(service);
    expect(only(after).payload.limitPrice?.amount).toBeCloseTo(0.01, 10);
    expect(only(after).payload.quantity).toBe(2);
    expect(usd(after).reserved).toBeCloseTo(0.02, 10);
  });

  it("1¢ 지정가 매수 + 3:1 → 지정가가 0¢ 이 되므로 fractional_result", async () => {
    // 겨눌 것 5. 예약 단가는 올림이라 1¢ 로 남지만 지정가는 반올림이라 0¢ 이 된다 —
    // 현금 천장이 이 경우를 함의하지 않는 이유가 정확히 이 갈라짐이다.
    const { service } = harness();
    const { account } = await submit(service, limitBuy(1, 0.01), "key:frac-buy-no");

    const before = usd(await shellOf(service));
    expect(before.reserved).toBeCloseTo(0.01, 10);

    const outcome = await applySplit(service, account, 3, 1);
    expect(outcome).toMatchObject({ status: "refused", reason: "fractional_result" });

    const after = await shellOf(service);
    expect(usd(after).reserved).toBeCloseTo(0.01, 10);
    expect(usd(after).balance).toBe(before.balance);
    expect(only(after).payload.quantity).toBe(1);
  });

  it("양성 대조군(매도): 10주 @ $50 + 2:1 은 통과하고 포지션·수량 예약이 배가 된다", async () => {
    // 겨눌 것 7. 수량 예약은 보존 대상이 아니다 — 5주가 10주가 되는 것이 정직한 결과다.
    const { service, account } = await withPosition(30);
    await submit(service, limitSell(10, 50), "key:sell-ok");

    const outcome = await applySplit(service, account, 2, 1);
    expect(outcome.status).toBe("applied");

    const after = await shellOf(service);
    expect(after.positions[0]?.quantity).toBe(60);
    expect(after.positions[0]?.reserved).toBe(20);
    const sell = after.orders.find((order) => order.payload.side === "sell");
    expect(sell?.payload.quantity).toBe(20);
    expect(sell?.payload.limitPrice?.amount).toBe(25);
  });

  it("1¢ 지정가 매도 + 3:1 → 매수와 같은 이유로 fractional_result", async () => {
    // 겨눌 것 6.
    const { service, account } = await withPosition(30);
    await submit(service, limitSell(30, 0.01), "key:sell-frac");

    const outcome = await applySplit(service, account, 3, 1);
    expect(outcome).toMatchObject({ status: "refused", reason: "fractional_result" });

    const after = await shellOf(service);
    expect(after.positions[0]?.quantity).toBe(30);
    expect(after.positions[0]?.reserved).toBe(30);
  });
});

describe("OF-6 · 부분 체결 — 예약은 미체결 수량 기준", () => {
  /** 20주 주문 중 10주만 체결(10% 거래량 상한)시킨다. */
  async function partiallyFilled(limit: number, key: string) {
    const { service, simulator } = harness();
    const { account } = await submit(service, limitBuy(20, limit), key);
    await simulator.ingest(WORKSPACE, account, observation({ volume: 100 }));
    const shell = await shellOf(service);
    expect(only(shell).filledQuantity).toBe(10);
    expect(only(shell).execution).toBe("partially_filled");
    return { service, account, shell };
  }

  it("미체결 10주 @ $110 은 2:1 후 20주 @ $55 — 예약이 그대로다", async () => {
    // 겨눌 것 8. 체결분 10주는 이미 잔고를 떠났으므로 예약은 미체결 10주 몫뿐이다.
    const { service, account, shell } = await partiallyFilled(110, "key:partial-even");
    expect(usd(shell).reserved).toBe(1100);
    const balanceBefore = usd(shell).balance;

    const outcome = await applySplit(service, account, 2, 1);
    expect(outcome.status).toBe("applied");

    const after = await shellOf(service);
    expect(usd(after).reserved).toBe(1100);
    expect(usd(after).balance).toBe(balanceBefore);
    expect(only(after).payload.quantity).toBe(40);
    expect(only(after).filledQuantity).toBe(20);
    expect(after.positions[0]?.quantity).toBe(20);
  });

  it("미체결 10주 @ $110.01 은 2:1 후 미체결 20주 × $55.01 — 올림 나머지만큼만 는다", async () => {
    // 겨눌 것 8 의 홀수 센트 판. v1 은 여기서 reservation_not_conserved 로 거절했다.
    const { service, account, shell } = await partiallyFilled(110.01, "key:partial-odd");
    expect(usd(shell).reserved).toBeCloseTo(1100.1, 10);
    const balanceBefore = usd(shell).balance;

    const outcome = await applySplit(service, account, 2, 1);
    expect(outcome.status).toBe("applied");

    const after = await shellOf(service);
    // ceil(11001/2) = 5501 minor = $55.01 → 미체결 20주 × $55.01 = $1,100.20.
    expect(usd(after).reserved).toBeCloseTo(1100.2, 10);
    expect(usd(after).balance).toBe(balanceBefore);
    expect(usd(after).reserved).toBeLessThanOrEqual(usd(after).balance);
    expect(only(after).payload.quantity).toBe(40);
    expect(only(after).filledQuantity).toBe(20);
    expect(only(after).payload.limitPrice?.amount).toBeCloseTo(55.01, 10);
  });
});

describe("OF-6 · 시장가 주문은 지정가를 가질 수 없다", () => {
  it("양성 대조군: limitPrice 없는 시장가 주문은 접수된다", async () => {
    const { service } = harness({ quote: observation({ price: { amount: 5, currency: "USD" } }) });
    const prepared = await service.prepare({ payload: marketBuy(4) }, viewer());
    expect(prepared.status).toBe("issued");
  });

  it("시장가 주문에 limitPrice 를 달면 접수 자체가 invalid_payload", async () => {
    // 겨눌 것 9. 예약은 관측치로, 체결 가드는 지정가로 값이 매겨지므로 분할이 둘을
    // 벌려 놓을 수 있다 — 애초에 받지 않는다.
    const { service } = harness({ quote: observation({ price: { amount: 5, currency: "USD" } }) });
    const payload = { ...marketBuy(4), limitPrice: { amount: 5, currency: "USD" } } as PaperOrderPayload;
    const prepared = await service.prepare({ payload }, viewer());
    expect(prepared).toMatchObject({ status: "refused", reason: "invalid_payload" });
  });

  it("시장가 예약 단가($1.01)도 올림으로 양자화되어 2:1 분할을 통과한다", async () => {
    // $1.00 × 1.0025 = $1.0025 → 틱 올림 → $1.01. 2:1 이면 ceil(101/2) = 51 minor.
    // v1 은 "0.505¢ 은 표현 불가"라며 거절했다.
    const { service } = harness({ quote: observation({ price: { amount: 1, currency: "USD" } }) });
    const { account } = await submit(service, marketBuy(3), "key:market-odd");

    const before = usd(await shellOf(service));
    expect(before.reserved).toBeCloseTo(3.03, 10);

    const outcome = await applySplit(service, account, 2, 1);
    expect(outcome.status).toBe("applied");

    const after = await shellOf(service);
    expect(usd(after).reserved).toBeCloseTo(3.06, 10);
    expect(usd(after).reserved).toBeLessThanOrEqual(usd(after).balance);
    expect(only(after).payload.quantity).toBe(6);
  });
});

describe("OF-6 · 안전정수 — 쪼개짐과 셀 수 있음은 다른 사실이다", () => {
  /** 1천만 주 포지션을 만든다(예약 단가 2¢, 관측가 1¢). */
  async function bigPosition() {
    const { service, simulator } = harness({ seedCash: [{ amount: 1_000_000, currency: "USD" }] });
    const quantity = 10_000_000;
    const { account } = await submit(service, limitBuy(quantity, 0.02), "key:big-buy");
    await simulator.ingest(
      WORKSPACE,
      account,
      observation({ price: { amount: 0.01, currency: "USD" }, volume: quantity * 10 }),
    );
    const shell = await shellOf(service);
    expect(shell.positions[0]?.quantity).toBe(quantity);
    return { service, account };
  }

  it("양성 대조군: 100:1 분할은 정수이고 안전정수 안이므로 통과한다", async () => {
    const { service, account } = await bigPosition();
    const outcome = await applySplit(service, account, 100, 1);
    expect(outcome.status).toBe("applied");
    expect((await shellOf(service)).positions[0]?.quantity).toBe(1_000_000_000);
  });

  it("분할 후 수량이 2^53 밖으로 나가면 invalid_adjustment — 정수여도 거부", async () => {
    // 겨눌 것 10. 1e7 × 1e9 = 1e16 > 2^53 (≈9.007e15).
    const { service, account } = await bigPosition();
    const outcome = await applySplit(service, account, 1_000_000_000, 1);
    expect(outcome).toMatchObject({ status: "refused", reason: "invalid_adjustment" });
    expect((await shellOf(service)).positions[0]?.quantity).toBe(10_000_000);
  });
});
