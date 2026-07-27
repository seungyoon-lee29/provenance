import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { InternalPaperAccountReference } from "@/shared/contracts/brands";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";
import { PaperJournal } from "../src/modules/paper-trading/internal/journal";
import { PaperTradingService } from "../src/modules/paper-trading/internal/service";
import type {
  PaperCorporateActionReference,
  PaperFillIdentity,
  PaperInstrumentReference,
  PaperMoney,
  PaperOrderPayload,
} from "../src/modules/paper-trading/internal/contracts";

/**
 * Round-2 BLIND acceptance — written from `.scratch/honesty-and-gates/blind-contract-round2.md`
 * alone. The goal is not green: it is to find inputs the contract forbids and
 * the implementation accepts (or the reverse). A red here is a finding.
 *
 * Every refusal case is paired with a positive control on the same axis, and
 * every boundary this file aims at is asserted to actually be where it is
 * claimed to be BEFORE any case leans on it.
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1 = 9_007_199_254_740_991
const NOW = "2026-07-18T02:00:00.000Z";
const LATER = "2026-07-18T02:01:00.000Z";
const WORKSPACE = "workspace:round2";
const SAMSUNG = brandReference<string, "PaperInstrumentReference">("instr:005930") as PaperInstrumentReference;
const HYNIX = brandReference<string, "PaperInstrumentReference">("instr:000660") as PaperInstrumentReference;

function accountFor(workspace: string): InternalPaperAccountReference {
  return brandReference<string, "InternalPaperAccountReference">(`paper-account:internal:${workspace}`);
}

function viewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-r2",
    workspaceReference: brandReference<string, "WorkspaceReference">(WORKSPACE),
    accountReference: brandReference<string, "AccountReference">("account:r2"),
    sessionReference: brandReference<string, "SessionReference">("session:r2"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
  };
}

// ---------------------------------------------------------------------------
// Premise assertions — if these fail every case below is meaningless.
// ---------------------------------------------------------------------------

describe("premises the round-2 cases stand on", () => {
  it("MAX_SAFE is the last safe integer and the values used as 'unsafe' really are unsafe", () => {
    expect(Number.isSafeInteger(MAX_SAFE)).toBe(true);
    expect(Number.isSafeInteger(MAX_SAFE + 1)).toBe(false);
    // Sums used below.
    expect(Number.isSafeInteger(5e15)).toBe(true);
    expect(Number.isSafeInteger(5e15 + 5e15)).toBe(false);
    // Minor-unit escalation: a safe MAJOR value whose MINOR value is not safe.
    expect(Number.isSafeInteger(1e14)).toBe(true);
    expect(Number.isSafeInteger(1e14 * 100)).toBe(false);
    // Sell/dividend sum cases: an exact product that overflows once added.
    expect(Number.isSafeInteger(1e15)).toBe(true);
    expect(Number.isSafeInteger(9_000_000_000_000_000 - 1_000 + 1e15)).toBe(false);
    // And the paired positive controls stay safe.
    expect(Number.isSafeInteger(9_000_000_000_000_000 - 1_000 + 1e11)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C-R2.1 — genesis
// ---------------------------------------------------------------------------

function freshJournal() {
  const journal = new PaperJournal(() => NOW);
  const account = accountFor(WORKSPACE);
  const open = (seedCash: readonly PaperMoney[], key = "genesis") =>
    journal.appendSystem(WORKSPACE, account, key, { kind: "account_opened", seedCash }, { owner: WORKSPACE });
  return { journal, account, open };
}

describe("C-R2.1 genesis seed cash", () => {
  it("premise: a single KRW seed exactly at the ceiling opens; one minor unit above does not", async () => {
    const a = freshJournal();
    expect(await a.open([{ amount: MAX_SAFE, currency: "KRW" }])).toEqual({ status: "applied", revision: expect.any(Number) });
    expect(a.journal.state(WORKSPACE, a.account).cash.get("KRW")?.balance).toBe(MAX_SAFE);

    const b = freshJournal();
    expect(await b.open([{ amount: MAX_SAFE + 1, currency: "KRW" }])).toEqual({ status: "refused", reason: "invalid_seed_cash" });
  });

  it("C-R2.1.1 sums seeds per currency: two individually safe KRW seeds whose SUM overflows are refused", async () => {
    const { open } = freshJournal();
    expect(
      await open([
        { amount: 5e15, currency: "KRW" },
        { amount: 5e15, currency: "KRW" },
      ]),
    ).toEqual({ status: "refused", reason: "invalid_seed_cash" });
  });

  it("C-R2.1.1 positive control: the same magnitudes in DIFFERENT currencies are not summed and open fine", async () => {
    const { journal, account, open } = freshJournal();
    // KRW 5e15 minor + USD 5e13 major (= 5e15 minor). Cross-currency total 1e16,
    // per-currency both safe. Must open.
    expect(await open([
      { amount: 5e15, currency: "KRW" },
      { amount: 5e13, currency: "USD" },
    ])).toEqual({ status: "applied", revision: expect.any(Number) });
    const state = journal.state(WORKSPACE, account);
    expect(state.cash.get("KRW")?.balance).toBe(5e15);
    expect(state.cash.get("USD")?.balance).toBe(5e15);
  });

  it("C-R2.1.2 judges the MINOR value: a safe major USD amount whose minor value overflows is refused", async () => {
    const { open } = freshJournal();
    expect(await open([{ amount: 1e14, currency: "USD" }])).toEqual({ status: "refused", reason: "invalid_seed_cash" });
  });

  it("C-R2.1.2 positive control: the same currency one decade lower (minor still safe) opens", async () => {
    const { journal, account, open } = freshJournal();
    expect(await open([{ amount: 1e13, currency: "USD" }])).toEqual({ status: "applied", revision: expect.any(Number) });
    expect(journal.state(WORKSPACE, account).cash.get("USD")?.balance).toBe(1e15);
  });

  it("C-R2.1.3 refuses non-finite seed amounts through the same reason", async () => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { open } = freshJournal();
      expect(await open([{ amount, currency: "KRW" }])).toEqual({ status: "refused", reason: "invalid_seed_cash" });
    }
  });

  it("C-R2.1.5 a refused genesis leaves the account unopened (ownerOf undefined, no cash)", async () => {
    const { journal, account, open } = freshJournal();
    expect((await open([{ amount: MAX_SAFE + 1, currency: "KRW" }])).status).toBe("refused");
    expect(journal.ownerOf(account)).toBeUndefined();
    expect(journal.state(WORKSPACE, account).cash.size).toBe(0);
    // ...and a subsequent VALID genesis still lands (the refusal burned nothing).
    expect((await open([{ amount: 1_000_000, currency: "KRW" }], "genesis-retry")).status).toBe("applied");
    expect(journal.ownerOf(account)).toBe(WORKSPACE);
  });

  it("C-R2.1.6 re-genesis is refused as already_opened BEFORE the seed is judged", async () => {
    const { open } = freshJournal();
    expect((await open([{ amount: 1_000_000, currency: "KRW" }])).status).toBe("applied");
    // A second genesis carrying a seed that would ALSO fail the cash check must
    // report already_opened — the ordering claim, not merely "some refusal".
    expect(await open([{ amount: Number.NaN, currency: "KRW" }], "regenesis")).toEqual({
      status: "refused",
      reason: "already_opened",
    });
  });
});

// ---------------------------------------------------------------------------
// Shared service harness for the position-bearing cases (KRW: minor scale 1,
// so every displayed amount below IS its minor value).
// ---------------------------------------------------------------------------

function harness(seedKrw: number) {
  let updateCounter = 0;
  const nowRef = { value: NOW };
  const service = new PaperTradingService({
    now: () => nowRef.value,
    identity: { currentAuthorizationEpoch: () => "epoch:1" },
    observations: { currentObservation: () => undefined },
    policy: {
      policyVersion: "simulation-v1",
      seedCash: [{ amount: seedKrw, currency: "KRW" }],
      intentTtlMs: 600_000,
      maxSlippageBps: 25,
    },
    updateId: () => `update:${(updateCounter += 1)}`,
  });
  return { service, nowRef };
}

function limitOrder(side: "buy" | "sell", quantity: number, limit: number, instrument = SAMSUNG): PaperOrderPayload {
  return {
    instrument,
    venue: "XKRX",
    session: "regular",
    side,
    orderType: "limit",
    limitPrice: { amount: limit, currency: "KRW" },
    quantity,
    timeInForce: "GTC",
  };
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

function fillBody(order: string, quantity: number, price: number, identity: string) {
  return {
    kind: "fill_applied" as const,
    fill: {
      identity: brandReference<string, "PaperFillIdentity">(identity) as PaperFillIdentity,
      order: brandReference<string, "PaperOrderReference">(order),
      quantity,
      price: { amount: price, currency: "KRW" },
      eventTime: LATER,
      receivedAt: "2026-07-18T02:01:01.000Z",
      evidenceReference: `evidence:${identity}`,
      policyVersion: "simulation-v1",
    },
  };
}

function dividendBody(instrument: PaperInstrumentReference, perShare: PaperMoney, tag: string) {
  return {
    kind: "dividend_applied" as const,
    action: brandReference<string, "PaperCorporateActionReference">(`action:${tag}`) as PaperCorporateActionReference,
    instrument,
    perShare,
  };
}

/** Seed 9e15 KRW, buy 10 @ 100 → balance 8_999_999_999_999_000, position 10. */
async function loadedAccount() {
  const { service } = harness(9_000_000_000_000_000);
  const { order, account } = await submit(service, limitOrder("buy", 10, 100), "r2-load");
  const filled = await service.journal.appendSystem(WORKSPACE, account, "r2-load-fill", fillBody(String(order), 10, 100, "fill:r2-load"));
  if (filled.status !== "applied") throw new Error(`load fill refused: ${JSON.stringify(filled)}`);
  const state = service.journal.state(WORKSPACE, account);
  expect(state.cash.get("KRW")?.balance).toBe(8_999_999_999_999_000);
  expect(state.positions.get(String(SAMSUNG))?.quantity).toBe(10);
  return { service, account };
}

// ---------------------------------------------------------------------------
// C-R2.2 — dividends
// ---------------------------------------------------------------------------

describe("C-R2.2 dividend accrual", () => {
  it("C-R2.2.1 refuses a dividend whose quantity × perShare product is not a safe integer", async () => {
    const { service, account } = await loadedAccount();
    expect(Number.isSafeInteger(10 * 1e16)).toBe(false); // premise
    expect(
      await service.journal.appendSystem(WORKSPACE, account, "div-huge", dividendBody(SAMSUNG, { amount: 1e16, currency: "KRW" }, "div-huge")),
    ).toEqual({ status: "refused", reason: "invalid_adjustment" });
  });

  it("C-R2.2.1 positive control: an ordinary dividend is applied and credits exactly quantity × perShare", async () => {
    const { service, account } = await loadedAccount();
    expect(
      (await service.journal.appendSystem(WORKSPACE, account, "div-ok", dividendBody(SAMSUNG, { amount: 361, currency: "KRW" }, "div-ok"))).status,
    ).toBe("applied");
    expect(service.journal.state(WORKSPACE, account).cash.get("KRW")?.balance).toBe(8_999_999_999_999_000 + 3_610);
  });

  it("C-R2.2.2 refuses when the product is exact but the POST-ACCRUAL BALANCE overflows", async () => {
    const { service, account } = await loadedAccount();
    expect(Number.isSafeInteger(10 * 1e14)).toBe(true); // the product itself is fine
    expect(Number.isSafeInteger(8_999_999_999_999_000 + 10 * 1e14)).toBe(false); // the sum is not
    expect(
      await service.journal.appendSystem(WORKSPACE, account, "div-sum", dividendBody(SAMSUNG, { amount: 1e14, currency: "KRW" }, "div-sum")),
    ).toEqual({ status: "refused", reason: "invalid_adjustment" });
    expect(service.journal.state(WORKSPACE, account).cash.get("KRW")?.balance).toBe(8_999_999_999_999_000);
  });

  it("C-R2.2.2 positive control: the largest accrual that still fits is applied", async () => {
    const { service, account } = await loadedAccount();
    expect(Number.isSafeInteger(8_999_999_999_999_000 + 10 * 1e10)).toBe(true);
    expect(
      (await service.journal.appendSystem(WORKSPACE, account, "div-fits", dividendBody(SAMSUNG, { amount: 1e10, currency: "KRW" }, "div-fits")))
        .status,
    ).toBe("applied");
    expect(service.journal.state(WORKSPACE, account).cash.get("KRW")?.balance).toBe(8_999_999_999_999_000 + 1e11);
  });

  it("C-R2.2.4 does NOT refuse a dividend on an instrument the account does not hold", async () => {
    const { service, account } = await loadedAccount();
    const outcome = await service.journal.appendSystem(
      WORKSPACE,
      account,
      "div-unheld",
      dividendBody(HYNIX, { amount: 1e16, currency: "KRW" }, "div-unheld"),
    );
    // Contract: "없는 보유에 대한 배당을 거부로 만들지 말 것" — even with an
    // absurd perShare, there is nothing to accrue, so nothing to refuse.
    expect(outcome.status).not.toBe("refused");
    expect(service.journal.state(WORKSPACE, account).cash.get("KRW")?.balance).toBe(8_999_999_999_999_000);
  });

  it("C-R2.2.4 does NOT refuse a dividend on a position that exists but has been sold down to 0", async () => {
    const { service } = await loadedAccount();
    const sell = await sellOrderOn(service, 10, 1, "div-zeroed");
    expect(
      (await service.journal.appendSystem(WORKSPACE, sell.account, "div-zero-fill", fillBody(String(sell.order), 10, 100, "fill:div-zeroed"))).status,
    ).toBe("applied");
    expect(service.journal.state(WORKSPACE, sell.account).positions.get(String(SAMSUNG))?.quantity).toBe(0);
    // Quantity is 0, so the fold accrues nothing — per C-R2.2.4 there is
    // nothing to refuse even though 0 × 1e16 would be "the product".
    const outcome = await service.journal.appendSystem(
      WORKSPACE,
      sell.account,
      "div-zero",
      dividendBody(SAMSUNG, { amount: 1e16, currency: "KRW" }, "div-zero"),
    );
    expect(outcome.status).not.toBe("refused");
  });

  it("C-R2.2.5 refuses a dividend whose currency differs from the holding's cost currency", async () => {
    const { service, account } = await loadedAccount();
    expect(
      (await service.journal.appendSystem(WORKSPACE, account, "div-fx", dividendBody(SAMSUNG, { amount: 10, currency: "USD" }, "div-fx"))).status,
    ).toBe("refused");
  });
});

// ---------------------------------------------------------------------------
// C-R2.3 — sell fills
// ---------------------------------------------------------------------------

async function sellOrderOn(service: PaperTradingService, quantity: number, limit: number, key: string) {
  return submit(service, limitOrder("sell", quantity, limit), key);
}

describe("C-R2.3 sell fill ceiling", () => {
  it("C-R2.3.1 refuses a sell whose gross product is not a safe integer", async () => {
    const { service } = await loadedAccount();
    const { order, account } = await sellOrderOn(service, 10, 1, "sell-gross");
    expect(Number.isSafeInteger(10 * 1e15)).toBe(false); // premise
    expect(await service.journal.appendSystem(WORKSPACE, account, "sell-gross-fill", fillBody(String(order), 10, 1e15, "fill:sell-gross"))).toEqual({
      status: "refused",
      reason: "invalid_fill",
    });
  });

  it("C-R2.3.2 refuses a sell whose gross is EXACT but whose post-fill balance overflows", async () => {
    const { service } = await loadedAccount();
    const { order, account } = await sellOrderOn(service, 10, 1, "sell-sum");
    expect(Number.isSafeInteger(10 * 1e14)).toBe(true); // the gross is fine
    expect(Number.isSafeInteger(8_999_999_999_999_000 + 10 * 1e14)).toBe(false); // the balance is not
    expect(await service.journal.appendSystem(WORKSPACE, account, "sell-sum-fill", fillBody(String(order), 10, 1e14, "fill:sell-sum"))).toEqual({
      status: "refused",
      reason: "invalid_fill",
    });
    expect(service.journal.state(WORKSPACE, account).cash.get("KRW")?.balance).toBe(8_999_999_999_999_000);
    expect(service.journal.state(WORKSPACE, account).positions.get(String(SAMSUNG))?.quantity).toBe(10);
  });

  it("C-R2.3.2 positive control: the largest sell that still fits is applied", async () => {
    const { service } = await loadedAccount();
    const { order, account } = await sellOrderOn(service, 10, 1, "sell-fits");
    expect(Number.isSafeInteger(8_999_999_999_999_000 + 10 * 1e10)).toBe(true);
    expect(
      (await service.journal.appendSystem(WORKSPACE, account, "sell-fits-fill", fillBody(String(order), 10, 1e10, "fill:sell-fits"))).status,
    ).toBe("applied");
    const state = service.journal.state(WORKSPACE, account);
    expect(state.positions.get(String(SAMSUNG))?.quantity).toBe(0);
    expect(Number.isSafeInteger(state.cash.get("KRW")!.balance)).toBe(true);
  });

  it("C-R2.3.2 the guard is on `balance + gross − tax`, not on `balance + gross`", async () => {
    // Contract text: "체결 후 잔고 = 잔고 + gross − 세금 이 안전정수여야 한다".
    // Here `balance + gross` alone is NOT safe, but the taxed result is — so a
    // refusal here means the implementation claims more than the contract.
    const { service } = await loadedAccount();
    const { order, account } = await sellOrderOn(service, 10, 1, "sell-tax");
    const tax = 995_000_000_000_000;
    expect(Number.isSafeInteger(8_999_999_999_999_000 + 10 * 1e14)).toBe(false);
    expect(Number.isSafeInteger(8_999_999_999_999_000 + 10 * 1e14 - tax)).toBe(true);
    const body = fillBody(String(order), 10, 1e14, "fill:sell-tax");
    const outcome = await service.journal.appendSystem(WORKSPACE, account, "sell-tax-fill", {
      ...body,
      fill: { ...body.fill, costs: { sellTransactionTaxMinor: tax, taxPolicyVersion: "krx-2026" } },
    });
    expect(outcome.status).toBe("applied");
    expect(service.journal.state(WORKSPACE, account).cash.get("KRW")?.balance).toBe(8_999_999_999_999_000 + 10 * 1e14 - tax);
  });

  it("C-R2.3.3 the buy path never refuses with invalid_fill for the balance reason (regression guard)", async () => {
    // Balance sits one unit under the ceiling; any buy can only move it DOWN,
    // so no buy fill may be rejected by the round-2 sum guard.
    const { service } = harness(MAX_SAFE);
    const { order, account } = await submit(service, limitOrder("buy", 10, 1_000_000), "buy-ceiling");
    const outcome = await service.journal.appendSystem(WORKSPACE, account, "buy-ceiling-fill", fillBody(String(order), 10, 1_000_000, "fill:buy-ceiling"));
    expect(outcome).toEqual({ status: "applied", revision: expect.any(Number) });
    const state = service.journal.state(WORKSPACE, account);
    expect(state.cash.get("KRW")?.balance).toBe(MAX_SAFE - 10_000_000);
    expect(state.positions.get(String(SAMSUNG))?.quantity).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// C-R2.4.2 — the un-guarded `reserved` sum: does the balance guard really cover it?
// ---------------------------------------------------------------------------

describe("C-R2.4.2 reserved is bounded by the balance guard (the argument under attack)", () => {
  it("a sell whose declared tax exceeds its gross must not drive balance below reserved (breaks the C-R2.4.2 argument if it can)", async () => {
    const { service } = harness(1_000_000);
    const buy = await submit(service, limitOrder("buy", 10, 100), "tax-load");
    expect((await service.journal.appendSystem(WORKSPACE, buy.account, "tax-load-fill", fillBody(String(buy.order), 10, 100, "fill:tax-load"))).status).toBe(
      "applied",
    );
    // Reserve the entire remaining balance with a second open buy.
    const hold = await submit(service, limitOrder("buy", 9_990, 100), "tax-hold");
    const held = service.journal.state(WORKSPACE, hold.account).cash.get("KRW")!;
    expect(held.balance).toBe(999_000);
    expect(held.reserved).toBe(999_000);

    // Now sell the 10 shares with an attacker-declared tax far above the gross.
    const sell = await sellOrderOn(service, 10, 1, "tax-sell");
    const body = fillBody(String(sell.order), 10, 100, "fill:tax-sell");
    const outcome = await service.journal.appendSystem(WORKSPACE, sell.account, "tax-sell-fill", {
      ...body,
      fill: { ...body.fill, costs: { sellTransactionTaxMinor: 10_000_000, taxPolicyVersion: "krx-2026" } },
    });
    const after = service.journal.state(WORKSPACE, sell.account).cash.get("KRW")!;
    // Measured: the boundary refuses it, so the C-R2.4.2 argument survives —
    // balance never drops below the outstanding reservation.
    expect(outcome.status).toBe("refused");
    expect(after.balance).toBe(999_000);
    expect(after.reserved).toBeLessThanOrEqual(after.balance);
  });


  it("reservations stay inside the balance across repeated below-limit fills (no reservation leak)", async () => {
    const { service } = harness(1_000_000);
    let account: InternalPaperAccountReference | undefined;
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const submitted = await submit(service, limitOrder("buy", 10, 100), `leak-${cycle}`);
      account = submitted.account;
      const reservedWhileOpen = service.journal.state(WORKSPACE, account).cash.get("KRW")!;
      expect(reservedWhileOpen.reserved).toBe(1_000);
      expect(reservedWhileOpen.reserved).toBeLessThanOrEqual(reservedWhileOpen.balance);
      // Fill BELOW the limit: the release must be the reservation, not the spend.
      const outcome = await service.journal.appendSystem(
        WORKSPACE,
        account,
        `leak-fill-${cycle}`,
        fillBody(String(submitted.order), 10, 55, `fill:leak-${cycle}`),
      );
      expect(outcome.status).toBe("applied");
      const after = service.journal.state(WORKSPACE, account).cash.get("KRW")!;
      expect(after.reserved).toBe(0);
      expect(after.balance).toBe(1_000_000 - 550 * (cycle + 1));
    }
    const final = service.journal.state(WORKSPACE, account!).cash.get("KRW")!;
    expect(Number.isSafeInteger(final.reserved)).toBe(true);
    expect(final.reserved).toBeLessThanOrEqual(final.balance);
  });

  it("a reservation can never be taken beyond the (ceiling-bounded) balance", async () => {
    const { service } = harness(MAX_SAFE);
    const first = await submit(service, limitOrder("buy", 1, MAX_SAFE), "reserve-all");
    const held = service.journal.state(WORKSPACE, first.account).cash.get("KRW")!;
    expect(held.reserved).toBe(MAX_SAFE);
    expect(Number.isSafeInteger(held.reserved)).toBe(true);
    expect(held.balance - held.reserved).toBe(0);
    // A second reservation of any size must now be impossible — this is the
    // whole argument C-R2.4.2 leans on.
    await expect(submit(service, limitOrder("buy", 1, 1), "reserve-more")).rejects.toThrow();
  });
});
