import type { ReportingMoney } from "./contracts";

/**
 * A position (or cash bucket) held through the P&L window, valued in its
 * native currency at both boundaries. `fx` (reporting per native unit) is
 * REQUIRED for a foreign row and FORBIDDEN for a reporting-currency row —
 * the type-level guard against converting twice (§8: 중복 없음). FX rates are
 * typed inputs produced upstream from PortfolioEvidenceResolver envelopes.
 */
export type PnlPositionRow = Readonly<{
  key: string;
  kind: "security" | "cash";
  nativeCurrency: string;
  startNativeValue: number;
  endNativeValue: number;
  fx?: Readonly<{ start: number; end: number }>;
}>;

export type PnlCharge = Readonly<{ kind: "fee" | "tax"; amount: ReportingMoney }>;

export type ReportingPnlInput = Readonly<{
  reportingCurrency: string;
  rows: readonly PnlPositionRow[];
  charges: readonly PnlCharge[];
}>;

export type PnlComponents = Readonly<{ price: number; fx: number; interaction: number; total: number }>;

export type ReportingPnlResult =
  | Readonly<{
      status: "covered";
      reportingCurrency: string;
      startReportingValue: number;
      gross: PnlComponents;
      /** Component returns on the start reporting value (AT-05: 10%+20%+2%=32%). */
      grossReturn: PnlComponents;
      fees: number;
      taxes: number;
      net: number;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "no_rows" | "missing_fx" | "invalid_fx" | "zero_base_row" | "mixed_currency" | "invalid_charge";
    }>;

/**
 * Reporting Currency P&L with an exact price/FX/interaction decomposition
 * (spec §8 / AT-05). Per row, with N = native value and F = fx rate:
 *
 *   price       = (N₁ − N₀)·F₀
 *   fx          = N₀·(F₁ − F₀)
 *   interaction = (N₁ − N₀)·(F₁ − F₀)
 *
 * These sum ALGEBRAICALLY to N₁F₁ − N₀F₀ — the reconciliation is an identity,
 * not an approximation, so no gain is counted twice or dropped. Cash rows use
 * the same identity (flat cash → fx-only). Net = gross − fees − taxes, each
 * charge exactly once.
 */
export function computeReportingPnl(input: ReportingPnlInput): ReportingPnlResult {
  if (input.rows.length === 0) return { status: "unavailable", reason: "no_rows" };

  let price = 0;
  let fxComponent = 0;
  let interaction = 0;
  let startReportingValue = 0;

  for (const row of input.rows) {
    const domestic = row.nativeCurrency === input.reportingCurrency;
    if (domestic && row.fx !== undefined) return { status: "unavailable", reason: "invalid_fx" };
    if (!domestic && row.fx === undefined) return { status: "unavailable", reason: "missing_fx" };
    const startFx = domestic ? 1 : row.fx?.start ?? 1;
    const endFx = domestic ? 1 : row.fx?.end ?? 1;
    if (row.startNativeValue <= 0 || startFx <= 0 || endFx <= 0) {
      return { status: "unavailable", reason: "zero_base_row" };
    }

    const nativeDelta = row.endNativeValue - row.startNativeValue;
    price += nativeDelta * startFx;
    fxComponent += row.startNativeValue * (endFx - startFx);
    interaction += nativeDelta * (endFx - startFx);
    startReportingValue += row.startNativeValue * startFx;
  }

  let fees = 0;
  let taxes = 0;
  for (const charge of input.charges) {
    if (charge.amount.currency !== input.reportingCurrency) {
      return { status: "unavailable", reason: "mixed_currency" };
    }
    if (charge.amount.amount < 0) return { status: "unavailable", reason: "invalid_charge" };
    if (charge.kind === "fee") fees += charge.amount.amount;
    else taxes += charge.amount.amount;
  }

  const total = price + fxComponent + interaction;
  return {
    status: "covered",
    reportingCurrency: input.reportingCurrency,
    startReportingValue,
    gross: { price, fx: fxComponent, interaction, total },
    grossReturn: {
      price: price / startReportingValue,
      fx: fxComponent / startReportingValue,
      interaction: interaction / startReportingValue,
      total: total / startReportingValue,
    },
    fees,
    taxes,
    net: total - fees - taxes,
  };
}
