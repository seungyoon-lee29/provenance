# Blind acceptance contract — arch-2 A+B (2026-07-27)

이 문서만 보고 반증 테스트를 쓴다. **구현 파일을 열지 않는다.**
목표는 "통과하는 테스트"가 아니라 **아래 계약을 위반하는 입력을 찾는 것**이다.

## C1 — `src/modules/paper-trading/backtest/performance-report.ts`

```ts
export type MaxDrawdown =
  | Readonly<{ status: "covered"; ratio: number }>
  | Readonly<{ status: "unavailable"; reason: "insufficient_curve" | "invalid_sample" }>;

export function maxDrawdown(equity: readonly number[]): MaxDrawdown;
```

계약:
1. 마크가 2개 미만 → `{status:"unavailable", reason:"insufficient_curve"}`. **0 이 아니다.**
2. 비유한(NaN/±Infinity) 또는 **음수** 마크가 하나라도 있으면 →
   `{status:"unavailable", reason:"invalid_sample"}`. 스킵하지 않는다.
3. 그 외 → `{status:"covered", ratio}`. `ratio` 는 최대 peak-to-trough 하락률, `[0,1]`.
   단조 비감소 곡선은 **covered 0**(잰 결과가 0인 것과 못 잰 것은 다르다).
4. 부분 회복 후 더 얕은 두 번째 낙폭이 첫 번째 최대값을 덮어쓰지 않는다.
5. `buildPerformance(...)` 의 `performance.maxDrawdown` 이 이 타입을 그대로 싣는다.
6. **어떤 입력에서도** `JSON.stringify(result)` 에 `null` 이 나타나지 않는다.

## C2 — `src/modules/actual-portfolio/calculation/corporate-actions.ts`

```ts
export function splitQuantityFactor(actions: readonly CorporateAction[], at: string): number;
export function resolveAccountingSeries(input: AccountingSeriesInput): AccountingSeriesResult;
```

`AccountingSeriesResult` 의 unavailable reason 유니언에 `"invalid_timestamp"` 가 추가됐다.

계약:
1. 모든 시각 비교는 **instant(정규화 ms)** 기준이다. ISO 문자열 사전순이 아니다.
   결정적 케이스: `"2026-03-05T00:00:00+09:00"` 는 `"2026-03-04T16:00:01Z"` 보다
   **9시간 이르다**(사전순으로는 뒤). split·delisting 판정이 이 차이로 뒤집히면 안 된다.
2. `splitQuantityFactor`: `at` **이후에** 발효되는 split 들의 ratio 곱. 동시각은 미포함.
3. `resolveAccountingSeries`: action `effectiveAt` 또는 point `at` 중 **하나라도**
   파싱 불가면 `{status:"unavailable", reason:"invalid_timestamp"}`.
4. delisting 이 여러 개면 **가장 이른 것**(instant 기준)이 이긴다. 반환되는 `delistedAt`
   문자열은 입력에 있던 원본 문자열 그대로다(정규화해서 바꾸지 않는다).
5. delisting 시각 **이상(≥)** 의 point 가 있으면 `post_delisting_price`.
6. `basis:"total_return_adjusted"` 는 항상 거부. 중복 `actionReference` 거부.
   merger/spin_off 의 `basisAllocation` 부재 거부.
7. `basis:"raw"` 일 때 각 point 가격은 `splitQuantityFactor` 로 나뉜다.

## C3 — `src/modules/actual-portfolio/calculation/transfers.ts`

```ts
export function computeScopeAwareReturn(input, changes): ScopeAwareReturnResult;
```

계약:
1. window·membership change·external flow 의 **모든** 시각이 instant 로 비교된다.
   하나라도 파싱 불가면 `{status:"unavailable", reason:"invalid_timestamp"}`.
2. 창 안(양끝 제외)에 break 가 없으면 통짜 `computePortfolioReturn(input)` 결과.
3. flow 가 break 시각과 **같은 instant** 면 `flow_at_scope_break`.
   다른 ISO 정밀도/오프셋으로 적힌 같은 시각도 같은 것으로 본다.
4. flow 가 창 경계 **이하/이상**(`<= from` 또는 `>= to`)이면 `flow_outside_window`.
   비세그먼트 경로가 이미 그렇게 거부하므로 세그먼트 경로도 같아야 한다 —
   어느 세그먼트에도 안 들어가고 조용히 사라지면 **위반이다**.
5. 세그먼트 배정은 instant 기준 `(fromCut, toCut)` 열린 구간이다.
6. 반환되는 세그먼트 window 의 바깥 양끝(`segments[0].window.from`,
   `segments[last].window.to`)은 **호출자가 준 원본 문자열 그대로**다.

## C4 — `src/modules/paper-trading/internal/contracts.ts` + journal 경계

```ts
export function isExactMinor(minorUnits: number): boolean;   // Number.isSafeInteger
export function grossMinorOf(quantity: number, price: PaperMoney): number;
```

계약:
1. `grossMinorOf(q, {amount, currency})` = `Math.round(q * amount * scale)`,
   `scale` 은 KRW 1 / 그 외 100. **집계 1회 반올림**(주당 반올림 아님).
2. journal 의 `fill_applied` 검증은 gross 가 `isExactMinor` 를 만족하지 않으면
   그 fill 을 거부한다. 비유한 quantity/price 도 같은 검사에 걸린다.
3. 거부는 fail-closed다: 잘못 반올림된 체결이 원장에 접히는 일이 없어야 한다.
4. 세금은 gross 를 초과할 수 없다. 매수에는 costs 가 붙을 수 없다.

## 검증 방법

- 테스트 파일: `tests/arch2-blind-honesty.test.ts` (새 파일, 이 이름 그대로)
- **공개 임포트 경로만** 사용한다. 구현 파일을 열어 읽지 않는다.
- 계약을 위반하는 입력을 찾으면 그 테스트는 **red 로 남긴다** — 통과시키려고
  기대값을 구현에 맞추지 않는다. red 가 발견이다.
- 통과/실패 목록과, blindness 를 어떻게 지켰는지(무엇을 열었는지)를 함께 보고한다.
