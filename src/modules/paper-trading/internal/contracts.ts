import type { Brand, InternalPaperAccountReference, PaperOrderReference } from "@/shared/contracts/brands";

/**
 * F8 Internal Paper Trading contracts (spec §9, UF-07, AT-07; ADR A04).
 *
 * Every reference is a Paper-owned brand: an Internal Paper account, order,
 * intent or fill can never be passed where an Actual reference is expected
 * (and vice versa) — the ledgers share no types, storage or revisions. The
 * three order state axes (submission / execution / cancellation) are
 * independent fields by construction; no combined enum exists that could
 * collapse them. Live Trading has no representation here at all.
 */

export type PaperJournalEntryReference = Brand<string, "PaperJournalEntryReference">;
export type PaperInstrumentReference = Brand<string, "PaperInstrumentReference">;
export type PaperOrderIntentReference = Brand<string, "PaperOrderIntentReference">;
/** Identity of one simulated fill — the exactly-once key for position changes. */
export type PaperFillIdentity = Brand<string, "PaperFillIdentity">;
export type PaperCorporateActionReference = Brand<string, "PaperCorporateActionReference">;

export type PaperMoney = Readonly<{ amount: number; currency: string }>;

/** Money in EXACT integer minor units — the ledger fold's internal money type. */
export type PaperMinorMoney = Readonly<{ minorUnits: number; currency: string }>;

/**
 * Minor units per major currency unit — the one shared tick/scale mapping for
 * both paper lanes (review carry-over: consolidates the per-file ternaries).
 * ponytail: two currencies is the product scope; a table when a third lands.
 */
export function currencyMinorUnitScale(currency: string): number {
  return currency === "KRW" ? 1 : 100;
}

/**
 * The ledger folds money in EXACT integer minor units (KRW: won, USD: cents),
 * never float major units — so cash conservation is exact and needs no epsilon.
 * `toMinorUnits` is the one boundary where an incoming display `PaperMoney`
 * (adapter/user float) is rounded into the integer domain; `fromMinorUnits`
 * is the one boundary back out, at presentation only. Inside the fold nothing
 * divides by the scale (Stage 2-c acceptance: zero non-integer float ops).
 */
export function minorUnitsOf(majorAmount: number, currency: string): number {
  // ponytail: minor units are JS `number` (safe-integer, ≤ 2^53 ≈ $90T in cents).
  // The paper sim never approaches that; move to bigint only if an institutional
  // book ever needs it (codex Stage 2-c noted the theoretical ceiling).
  // That ceiling is a real precondition, not a footnote — `isExactMinor` below
  // is how the journal boundary ENFORCES it, on genesis seeds, the fill product,
  // the dividend credit and the resulting cash balance. A documented limit
  // nothing checks is a comment, not a limit — which is what it was until
  // round 2: the round-1 version of this line said seed cash "already" enforced
  // the ceiling, and no such check existed on this path (it lived in
  // `backtest-runner`'s own seed validation, another module — round 3 moved the
  // predicate here as `isRepresentableCash` so there is one). Naming an enforcer
  // you have not grepped for is the same defect one level up.
  //
  // Cite by SYMBOL, never by line. Round 2 wrote three `:NNN` references into
  // these files and adversarial review found all three off by exactly 49 —
  // pre-edit numbering, invalidated by that same commit's own insertions. This
  // repo had already been bitten once (`e7d2b41`). Line numbers drift by
  // construction; a symbol name is checkable by grep and survives editing.
  return Math.round(majorAmount * currencyMinorUnitScale(currency));
}

/**
 * Does this minor-unit figure still live in the exact integer domain the fold
 * assumes? Past 2^53 the nearest representable double is no longer the true
 * product, so `Math.round` returns a neighbouring integer and cash conservation
 * silently stops being exact — the one premise the whole integer ledger rests on.
 * The refusal itself lives at the journal boundary, where a refusal channel
 * already exists; the arithmetic here stays a plain total.
 */
export function isExactMinor(minorUnits: number): boolean {
  return Number.isSafeInteger(minorUnits);
}

export function toMinorUnits(money: PaperMoney): number {
  return minorUnitsOf(money.amount, money.currency);
}

/**
 * True when `money` is a POSITIVE whole number of the currency's minor units
 * inside the safe-integer range — the only cash the integer ledger can take in
 * without silent rounding. Three rejections in one predicate: `-1` (a negative
 * balance voids the "both operands non-negative ⇒ the fold's subtraction is
 * exact" premise the whole ceiling argument rests on), `0.005` (sub-unit — it
 * would round INTO the ledger as 1 and fabricate money), and NaN/±Infinity.
 *
 * Note it tests the RAW product, not `toMinorUnits`: rounding first would erase
 * the sub-unit case, which is the one a reader is most likely to think is
 * harmless.
 *
 * It lived as a private function in `backtest-runner.ts` until 2026-07-27, and
 * that is precisely why round 2's genesis guard was weaker than the precedent
 * its own comment cited — the durable path could not reach it, so it re-derived
 * half of it. Adversarial review reproduced the gap: a −$1,000,000 seed was
 * ACCEPTED and folded to a balance of −100000000. One definition, two callers.
 */
export function isRepresentableCash(money: PaperMoney): boolean {
  const scale = currencyMinorUnitScale(money.currency);
  const minor = Math.round(money.amount * scale);
  // The test is a ROUND TRIP, not `isSafeInteger(amount * scale)`. That was the
  // form this predicate had while it was private to `backtest-runner`, and it
  // rejects ordinary money: `fromMinorUnits(1003, "USD")` is `10.03`, and
  // `10.03 * 100` is `1002.9999999999999` in binary floating point. Every seed
  // derived from a cent count would have been refused. Found by the money
  // conservation property test the moment the predicate reached this path.
  //
  // `minor / scale === money.amount` is exact and needs no epsilon: it accepts
  // exactly those amounts that survive the trip into the integer domain and back.
  // Measured over 2.2M cent and won values: zero false rejections, while `0.5`
  // KRW (half a won), `0.005` USD, `-1`, `0`, NaN, ±Infinity and `1e19` are all
  // still refused. The division is fine here — this is a boundary validator, not
  // the fold, and `fromMinorUnits` already divides at presentation.
  return money.amount > 0 && isExactMinor(minor) && minor / scale === money.amount;
}

/** Gross proceeds/cost of a fill in integer minor units — aggregate-rounded
 * ONCE (never per share). The single definition the simulator, the fold, the
 * fill validator, the reservation bound, the dividend credit and the backtest
 * equity mark all share, so a sub-tick price rounds identically at every site.
 * That sharing is the point: the claim was here before the call sites were,
 * and SEVEN of them still spelled the same product out by hand — which is
 * exactly how "must match" drifts back in without anyone editing this line.
 * (Counted by diff, not by memory: journal ×4, simulator ×2, service ×1.) */
export function grossMinorOf(quantity: number, price: PaperMoney): number {
  return minorUnitsOf(quantity * price.amount, price.currency);
}

export function fromMinorUnits(minorUnits: number, currency: string): PaperMoney {
  return { amount: minorUnits / currencyMinorUnitScale(currency), currency };
}

export type PaperOrderPayload = Readonly<{
  instrument: PaperInstrumentReference;
  venue: string;
  /** Initial product scope is regular-session cash equities/ETFs only (§9). */
  session: "regular";
  side: "buy" | "sell";
  orderType: "market" | "limit";
  limitPrice?: PaperMoney;
  quantity: number;
  timeInForce: "DAY" | "GTC";
}>;

export type SubmissionState = "draft" | "pending_submission" | "acknowledged" | "rejected" | "submission_unknown";
export type ExecutionState = "not_started" | "open" | "partially_filled" | "filled" | "expired";
export type CancellationState = "none" | "requested" | "confirmed" | "rejected";

/** Instrument tax classification the data source declares (T8 S3). Domain data
 * — the RATE LOGIC keyed on it lives in krx-transaction-tax.ts, which imports
 * this type, so the generic contract never depends on Korea-specific behaviour. */
export type KrxTaxClass = "equity" | "etf_etn";

/** Realized costs charged against a fill (T8 S3). Present only on taxed sells;
 * absent means zero cost. Buys carry no costs (Korean transaction tax is
 * sell-only). Stored append-only so a rate-table change never rewrites history.
 * The class is not stored — the report discloses the policy version, and the
 * amount is the only value the fold consumes (design doc D2). */
export type PaperFillCosts = Readonly<{
  /** Sell transaction tax in integer minor units, floored. */
  sellTransactionTaxMinor: number;
  taxPolicyVersion: string;
}>;

/** A simulated fill applied to an order (spec §9 simulation-v1). */
export type PaperFill = Readonly<{
  identity: PaperFillIdentity;
  order: PaperOrderReference;
  quantity: number;
  /** Slippage-adjusted, tick-rounded execution price. */
  price: PaperMoney;
  /** Market event time of the observation used (must be > acceptedAt). */
  eventTime: string;
  receivedAt: string;
  evidenceReference: string;
  policyVersion: string;
  costs?: PaperFillCosts;
}>;

export type PaperOrderView = Readonly<{
  order: PaperOrderReference;
  account: InternalPaperAccountReference;
  payload: PaperOrderPayload;
  submission: SubmissionState;
  execution: ExecutionState;
  cancellation: CancellationState;
  acceptedAt?: string;
  filledQuantity: number;
  fills: readonly PaperFill[];
}>;

export type PaperCashRow = Readonly<{ currency: string; balance: number; reserved: number; available: number }>;

export type PaperPositionRow = Readonly<{
  instrument: PaperInstrumentReference;
  quantity: number;
  /** Quantity held back for open sell orders (oversell guard). */
  reserved: number;
  /** Raw cost basis in the instrument currency, corporate-action adjusted exactly once. */
  costBasis: PaperMoney;
}>;

/**
 * Opaque one-time server record (spec §9): the browser only ever holds the
 * reference. Binding covers workspace, auth epoch, account kind/id/revision,
 * paper environment, simulation policy and expiry — submit re-checks every
 * one of them from the workspace-scoped store. The payload itself is
 * server-held on the record, so nothing client-supplied needs a hash check.
 */
export type PaperOrderIntentView = Readonly<{
  reference: PaperOrderIntentReference;
  account: InternalPaperAccountReference;
  accountKind: "internal";
  environment: "paper";
  accountRevision: number;
  policyVersion: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type PaperPrepareRequest = Readonly<{
  /** Omitted → the workspace's default Internal Paper Account (provisioned lazily). */
  account?: InternalPaperAccountReference;
  payload: PaperOrderPayload;
}>;

export type PaperPrepareOutcome =
  | Readonly<{ status: "issued"; intent: PaperOrderIntentView }>
  | Readonly<{ status: "denied" }>
  | Readonly<{ status: "refused"; reason: "invalid_payload" | "unknown_account" }>;

export type PaperTradingCommand =
  | Readonly<{ kind: "submit"; account: InternalPaperAccountReference; intent: PaperOrderIntentReference }>
  | Readonly<{ kind: "cancel"; account: InternalPaperAccountReference; order: PaperOrderReference }>;

export type PaperCommandOutcome =
  | Readonly<{ status: "applied"; revision: number; order: PaperOrderReference }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "rejected"; currentRevision: number }>
  | Readonly<{
      status: "refused";
      reason:
        | "unknown_account"
        | "unknown_order"
        | "already_cancelled"
        | "unknown_intent"
        | "intent_consumed"
        | "intent_expired"
        | "insufficient_cash"
        | "insufficient_position"
        | "no_valid_observation";
    }>
  /** SEC-01: guest, stale auth epoch or a cross-workspace account/intent id. */
  | Readonly<{ status: "denied" }>
  | Readonly<{ status: "suppressed" }>;

/** Real Market Observation offered to reservation bounding and the simulator. */
export type PaperMarketObservation = Readonly<{
  instrument: PaperInstrumentReference;
  venue: string;
  session: "regular";
  price: PaperMoney;
  volume: number;
  eventTime: string;
  receivedAt: string;
  /** Data clock of the feed — delayed feeds evaluate only after it passes acceptedAt. */
  dataClock: string;
  freshness: "realtime" | "delayed" | "stale" | "hard_expired";
  evidenceReference: string;
  /** Korean transaction-tax class the source declares for this instrument
   * (T8 S3). Undefined ⇒ untaxed simulation. Tax applies to sells only. */
  taxClass?: KrxTaxClass;
}>;

export interface PaperObservationPort {
  /** Freshest valid observation for reservation bounding, if any. */
  currentObservation(instrument: PaperInstrumentReference): PaperMarketObservation | undefined;
}
