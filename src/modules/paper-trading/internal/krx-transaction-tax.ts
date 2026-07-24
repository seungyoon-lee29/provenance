import type { KrxTaxClass } from "./contracts";

// Re-exported so callers keyed on the tax domain import the class from here.
export type { KrxTaxClass } from "./contracts";

/**
 * T8 S3 — Korean securities transaction tax (증권거래세 + 농어촌특별세) on SELLS.
 *
 * A cost, not slippage: the fill price is unchanged; the tax reduces the cash
 * credited on a sale (spec §9 cost path; design doc D1). Buys are untaxed in
 * Korea. The rate is a function of the KST execution year and the instrument
 * class — reference data the DATA SOURCE declares (`observation.taxClass`); the
 * engine never guesses it. KOSPI (거래세 + 농특세) and KOSDAQ (거래세, no 농특세)
 * net to the SAME combined sell rate every year, so a single `equity` rate
 * covers both; ETF/ETN sales are transaction-tax exempt.
 *
 * The verified range is 2020–present (web 3 sources + 국가법령정보센터, 2026-07-25).
 * 2019 and earlier are NOT year-keyable — the 2019-06-03 mid-year cut (30→25bp)
 * means one year holds two rates — so the table returns `null` there and the
 * caller (backtest runner) fails closed rather than fabricate a wrong historical
 * rate ("값을 모르면 지어내지 않는다"). 1차 법령 대조와 절사 관행 확인은 design
 * doc §4 체크리스트 잔여.
 *
 * The type `KrxTaxClass` lives in the domain contract (`contracts.ts`); this
 * module owns the RATE LOGIC and imports the type, so the generic contract
 * never depends on Korea-specific behaviour (Ports & Adapters).
 */

export const KRX_TAX_POLICY_VERSION = "krx-str-v1";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstYear(executionMs: number): number {
  return new Date(executionMs + KST_OFFSET_MS).getUTCFullYear();
}

/** Combined securities-transaction sell-tax rate in basis points, by KST year,
 * or null for a year outside the verified range (fail closed upstream). */
function equityRateBp(year: number): number | null {
  if (year >= 2026) return 20; // 금투세 무산 → 2023 수준 환원
  if (year === 2025) return 15;
  if (year === 2024) return 18;
  if (year === 2023) return 20;
  if (year === 2021 || year === 2022) return 23; // 0.08%+0.15% KOSPI / 0.23% KOSDAQ
  if (year === 2020) return 25; // KOSPI 0.10%+0.15% / KOSDAQ 0.25%
  return null; // ≤2019: not year-keyable (2019-06-03 mid-year cut) — unsupported
}

/** True when the KST execution date has a verified tax rate. The runner uses
 * this to refuse a taxed series that reaches into the unverified past. */
export function isSupportedTaxDate(executionDateIso: string): boolean {
  const ms = Date.parse(executionDateIso);
  return Number.isFinite(ms) && equityRateBp(kstYear(ms)) !== null;
}

/**
 * Sell transaction tax in integer minor units, floored (원 미만 버림 관례).
 * `grossMinor` is the sale proceeds in minor units (quantity × execution price,
 * already aggregate-rounded by the caller — never per share).
 *
 * Returns 0 for: exempt classes, non-positive proceeds (no sale value to tax —
 * blind gate), a malformed instant, and an unsupported year (the runner refuses
 * these before any fill, so 0 here is only a defensive backstop). The rate ×
 * gross product is taken in BigInt so a safe-integer gross cannot lose a minor
 * unit to float rounding before the floor (design doc D4; codex gate).
 */
export function sellTransactionTaxMinor(grossMinor: number, taxClass: KrxTaxClass, executionDateIso: string): number {
  if (taxClass === "etf_etn" || grossMinor <= 0) return 0;
  const ms = Date.parse(executionDateIso);
  if (!Number.isFinite(ms)) return 0;
  const bp = equityRateBp(kstYear(ms));
  if (bp === null) return 0;
  return Number((BigInt(grossMinor) * BigInt(bp)) / 10_000n);
}

function demo(): void {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`krx-transaction-tax demo: ${msg}`);
  };
  const on = (year: string) => `${year}-06-01T04:00:00.000Z`;
  assert(sellTransactionTaxMinor(1_000_000, "equity", on("2020")) === 2_500, "2020 = 25bp");
  assert(sellTransactionTaxMinor(1_000_000, "equity", on("2021")) === 2_300, "2021 = 23bp");
  assert(sellTransactionTaxMinor(1_000_000, "equity", on("2024")) === 1_800, "2024 = 18bp");
  assert(sellTransactionTaxMinor(1_000_000, "equity", on("2025")) === 1_500, "2025 = 15bp");
  assert(sellTransactionTaxMinor(1_000_000, "equity", on("2026")) === 2_000, "2026 = 20bp");
  assert(sellTransactionTaxMinor(1_000_000, "etf_etn", on("2026")) === 0, "etf exempt");
  // Unsupported year fails to 0 here; the runner refuses it up front.
  assert(sellTransactionTaxMinor(1_000_000, "equity", on("2019")) === 0, "≤2019 unsupported");
  assert(!isSupportedTaxDate(on("2019")) && isSupportedTaxDate(on("2020")), "supported floor = 2020");
  // KST year boundary: 2025-12-31T15:30Z is 2026-01-01 KST → 20bp, not 15.
  assert(sellTransactionTaxMinor(1_000_000, "equity", "2025-12-31T15:30:00.000Z") === 2_000, "KST year rollover");
  assert(sellTransactionTaxMinor(1_000_000, "equity", "2025-12-31T14:59:59.999Z") === 1_500, "just before rollover");
  // Floor and non-negative clamp.
  assert(sellTransactionTaxMinor(999, "equity", on("2025")) === 1, "floor");
  assert(sellTransactionTaxMinor(-1_000_000, "equity", on("2026")) === 0, "negative proceeds → 0");
  // BigInt exactness at safe-integer-max gross (float would return ...481).
  assert(sellTransactionTaxMinor(9_007_199_254_740_499, "equity", on("2026")) === 18_014_398_509_480, "BigInt no float drift");
}

if (process.argv[1]?.endsWith("krx-transaction-tax.ts")) demo();
