import type { ActualInstrumentReference } from "./contracts";
import type { EffectiveRecord } from "./projection";

/**
 * F6 baseline valuation presentation (UF-06). Values come only from the
 * scripted price/FX port (no provider gate in this ticket; the production port
 * is the FinancialInformation `PortfolioEvidenceResolver` seam). The section
 * type makes the no-promotion rule structural: a total and per-row weights
 * exist ONLY on the `complete` variant — a partial section can carry a known
 * subtotal plus the missing list, never a total, and nothing here computes
 * returns, rebalancing proposals or any derived history (F7 owns calculation).
 */

export type Money = Readonly<{ amount: number; currency: string }>;

export type ScriptedQuote =
  | Readonly<{ available: true; unitPrice: Money; asOf: string }>
  | Readonly<{ available: false }>;

export type ScriptedFxRate =
  | Readonly<{ available: true; rate: number; asOf: string }>
  | Readonly<{ available: false }>;

export interface ActualPriceFxPort {
  quote(instrument: ActualInstrumentReference): ScriptedQuote;
  fxRate(fromCurrency: string, toCurrency: string): ScriptedFxRate;
}

export type PositionRow = Readonly<{
  instrument: string;
  signedQuantity: number;
  aggregateLot: boolean;
  asOf: string;
  source: string;
  /** Position-currency market value, present when the price is known. */
  originalValue?: Money;
  /** Reporting-currency value, present when price AND fx are known. */
  reportingValue?: Money;
}>;

export type ValuedPositionRow = PositionRow & Readonly<{ weight: number }>;

export type MissingValuation = Readonly<{ instrument: string; reason: "price" | "fx" }>;

export type PositionsSection =
  | Readonly<{ completeness: "complete"; total: Money; rows: readonly ValuedPositionRow[] }>
  | Readonly<{ completeness: "partial"; knownSubtotal: Money; missing: readonly MissingValuation[]; rows: readonly PositionRow[] }>
  | Readonly<{ completeness: "unavailable"; missing: readonly MissingValuation[]; rows: readonly PositionRow[] }>;

export function presentPositionsSection(
  records: readonly EffectiveRecord[],
  port: ActualPriceFxPort,
  reportingCurrency = "KRW",
): PositionsSection {
  const rows: PositionRow[] = [];
  const missing: MissingValuation[] = [];

  for (const record of records) {
    if (record.payload.kind === "portfolio_activity") continue;
    const position = record.payload.position;
    const instrument = String(position.instrument);
    const base: PositionRow = {
      instrument,
      signedQuantity: position.signedQuantity,
      aggregateLot: record.aggregateLot,
      asOf: position.asOf,
      source: String(position.source),
    };
    const quote = port.quote(position.instrument);
    if (!quote.available) {
      missing.push({ instrument, reason: "price" });
      rows.push(base);
      continue;
    }
    const originalValue: Money = {
      amount: position.signedQuantity * quote.unitPrice.amount,
      currency: quote.unitPrice.currency,
    };
    const fx = port.fxRate(quote.unitPrice.currency, reportingCurrency);
    if (!fx.available) {
      missing.push({ instrument, reason: "fx" });
      rows.push({ ...base, originalValue });
      continue;
    }
    rows.push({
      ...base,
      originalValue,
      reportingValue: { amount: originalValue.amount * fx.rate, currency: reportingCurrency },
    });
  }

  const valued = rows.filter((row): row is PositionRow & { reportingValue: Money } => row.reportingValue !== undefined);
  const subtotal = valued.reduce((sum, row) => sum + row.reportingValue.amount, 0);

  if (missing.length === 0) {
    const total: Money = { amount: subtotal, currency: reportingCurrency };
    return {
      completeness: "complete",
      total,
      rows: valued.map((row) => ({ ...row, weight: total.amount === 0 ? 0 : row.reportingValue.amount / total.amount })),
    };
  }
  if (valued.length > 0) {
    return {
      completeness: "partial",
      knownSubtotal: { amount: subtotal, currency: reportingCurrency },
      missing,
      rows,
    };
  }
  return { completeness: "unavailable", missing, rows };
}
