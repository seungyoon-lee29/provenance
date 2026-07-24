/**
 * T8 S3 — Korean securities transaction tax (증권거래세 + 농어촌특별세) on SELLS.
 *
 * A cost, not slippage: the fill price is unchanged; the tax reduces the cash
 * credited on a sale (spec §9 cost path; design doc D1). Buys are untaxed in
 * Korea. The rate is a function of the KST execution year and the instrument
 * class — reference data the DATA SOURCE declares (`observation.taxClass`); the
 * engine never guesses it. An undeclared class means an untaxed simulation,
 * disclosed in the report, not a silent zero.
 *
 * Class collapses to two: KOSPI (거래세 + 농특세) and KOSDAQ (거래세, no 농특세)
 * net to the SAME combined sell rate every year, so a single `equity` rate
 * covers both; ETF/ETN sales are transaction-tax exempt.
 *
 * Rates verified 2026-07-25 (web, 3 sources): the 2026 rise (금투세 무산 →
 * 2023 수준 환원) is included. 1차 법령 대조는 design doc §4 체크리스트 잔여.
 */

export type KrxTaxClass = "equity" | "etf_etn";

export const KRX_TAX_POLICY_VERSION = "krx-str-v1";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Combined securities-transaction sell-tax rate in basis points, by KST year. */
function equityRateBp(kstYear: number): number {
  if (kstYear <= 2022) return 23;
  if (kstYear === 2023) return 20;
  if (kstYear === 2024) return 18;
  if (kstYear === 2025) return 15;
  return 20; // 2026~ (금투세 무산 → 2023 수준 환원; 다음 개정 시 행 추가)
}

/**
 * Sell transaction tax in integer minor units, floored (원 미만 버림 관례).
 * `grossMinor` is the sale proceeds in minor units (quantity × execution price,
 * already aggregate-rounded by the caller — never per share). Returns 0 for
 * exempt classes and for a proceeds/rate combination below one minor unit.
 */
export function sellTransactionTaxMinor(grossMinor: number, taxClass: KrxTaxClass, executionDateIso: string): number {
  if (taxClass === "etf_etn") return 0;
  const ms = Date.parse(executionDateIso);
  // Caller validates eventTime before a fill exists; guard defensively so a
  // malformed instant can never produce a NaN tax that corrupts the ledger.
  if (!Number.isFinite(ms)) return 0;
  const kstYear = new Date(ms + KST_OFFSET_MS).getUTCFullYear();
  return Math.floor((grossMinor * equityRateBp(kstYear)) / 10_000);
}

function demo(): void {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`krx-transaction-tax demo: ${msg}`);
  };
  // 1,000,000 KRW (scale 1) sale, by year.
  assert(sellTransactionTaxMinor(1_000_000, "equity", "2025-06-01T04:00:00.000Z") === 1_500, "2025 = 15bp");
  assert(sellTransactionTaxMinor(1_000_000, "equity", "2026-06-01T04:00:00.000Z") === 2_000, "2026 = 20bp");
  assert(sellTransactionTaxMinor(1_000_000, "equity", "2022-06-01T04:00:00.000Z") === 2_300, "≤2022 = 23bp");
  // ETF/ETN exempt.
  assert(sellTransactionTaxMinor(1_000_000, "etf_etn", "2026-06-01T04:00:00.000Z") === 0, "etf exempt");
  // KST year boundary: 2025-12-31T15:30Z is 2026-01-01 KST → 20bp, not 15.
  assert(sellTransactionTaxMinor(1_000_000, "equity", "2025-12-31T15:30:00.000Z") === 2_000, "KST year rollover");
  // Floor: 15bp on 999 won → floor(1.4985) = 1.
  assert(sellTransactionTaxMinor(999, "equity", "2025-06-01T04:00:00.000Z") === 1, "floor");
  // Malformed instant is defensively untaxed, never NaN.
  assert(sellTransactionTaxMinor(1_000_000, "equity", "not-a-date") === 0, "malformed → 0");
}

if (process.argv[1]?.endsWith("krx-transaction-tax.ts")) demo();
