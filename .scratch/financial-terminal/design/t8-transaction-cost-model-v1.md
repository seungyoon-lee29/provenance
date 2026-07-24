# T8 설계 스케치 v1 — 거래세 cost 모델 (fill 회계 편입)

> 상태: **설계만** (2026-07-24). 구현 아님 — 배선은 T8 백테스트 골격 뒤 접합.
> **구현 시 Blast radius / tier 선언**: money 경로(원장 fold·fill 회계) = **top tier**.
> collaboration.md tier 표 기준 blind test-authorship + codex 반박 패널 + Standards 축,
> 커밋에 `Tier: top (...)` 트레일러 (tier-gate가 커밋 레벨에서 강제).
> 근거 문맥: pivot 메모 §4 정정 ⑥ (2026-07-24) — `commissions are zero`, 결정5의 거래세가 fill path에 없음.

## 0. 한 줄 요약

거래세는 **가격이 아니라 현금 이동**이다. 슬리피지 함수(`executionPriceTicks`)에 넣지 않고,
**fill 이벤트에 비용을 저장 → 원장 fold가 저장액만 적용 → property가 독립 재계산으로 항등 검증**한다.

## 1. 결정 5개

### D1 — 슬리피지와 분리. cost는 별도 축이다
Zipline·Lean도 slippage(가격 형성)와 commission(비용)을 분리한다. 거래세를 bps로 슬리피지에
녹이면 ① 매도만 붙는 비대칭이 안 맞고 ② limit guard가 세금 때문에 fill을 거절하는 오동작이
생기고 ③ 리포트에서 "시장 비용 vs 세금"을 못 가른다. **fill 가격은 그대로, 현금 credit에서 차감.**

### D2 — 비용은 이벤트 생성 시 계산해 `PaperFill`에 저장 (append-only 규율)
`policyVersion: "simulation-v1"`과 같은 이유: 세율 정책이 바뀌어도 과거 이벤트는 불변이어야
리플레이가 같은 상태로 수렴한다. fold가 세율을 다시 계산하면 정책 변경이 역사를 다시 쓴다.
→ simulator가 fill 구성 시(`simulator.ts:174` 근방) 계산, fold는 **저장된 금액만** 적용.

```ts
// contracts.ts — PaperFill 확장
costs?: Readonly<{
  /** 매도 시 증권거래세+농특세 합산, minor units 정수. 매수는 0이라 필드 자체 생략. */
  sellTransactionTaxMinor: number;
  taxPolicyVersion: string;   // 예: "krx-str-v1"
}>;
```

### D3 — 세율은 (venue, instrument 종류, 체결일)의 함수. 상수 하나가 아니다
백테스트가 과거 구간을 돌므로 **체결일 기준 세율 테이블**이 필요하다. 한국 증권거래세는
최근 매년 개정됐고 **2026부터 다시 인상됐다** (2026-07-24 웹 3소스 교차 확인 — 머니투데이·
한국세정신문·glasswallet 일관. 1차 출처(법령) 대조는 §4 체크리스트 잔여):

| 체결일 | KOSPI (거래세+농특세) | KOSDAQ | 합산 매도세율 |
|---|---|---|---|
| ~2022 | 0.08%+0.15% | 0.23% | 0.23% |
| 2023 | 0.05%+0.15% | 0.20% | 0.20% |
| 2024 | 0.03%+0.15% | 0.18% | 0.18% |
| 2025 | 0%+0.15% | 0.15% | 0.15% |
| 2026~ | 0.05%+0.15% | 0.20% | **0.20%** (금투세 무산 → 2023 수준 환원, 1/1 양도분부터) |

**v1 초안 테이블은 "2025~ 0.15%"로 끝나 있었다 — 검증에서 2026 인상 누락이 잡혔다.**
이 개정 이력 자체가 D3(세율=체결일 함수)의 실증이다: 2025 구간 백테스트와 2026 실시간 모의가
다른 세율을 써야 하므로 상수 하나는 첫날부터 틀린다.

- **ETF/ETN은 증권거래세 면제** — v1 대상이 "현금 주식/ETF"(spec §9)이므로 instrument 종류
  분기가 필수다. ETF 매도에 주식 세율을 물리면 백테스트가 연 수십 bps 틀린다. (면제는 웹 확인됨 — §4)
- pivot 메모 §3 결정5의 "0.15%+농특세" 표기는 2025+ 기준 부정확 (0.15%가 곧 농특세[KOSPI] 또는
  거래세[KOSDAQ]). 리포트는 합산만 쓰고 분해는 테이블 주석으로 (분해 표시는 YAGNI).
- 테이블은 `krx-holidays.ts`와 같은 static 번들 패턴 (network-off 유지).

### D4 — 정수 minor-unit, aggregate에 한 번, 절사
기존 규율 그대로: `journal.ts:745`가 aggregate를 한 번 라운딩하듯, 세금도
`grossMinor`(체결 총액)에 세율 적용 후 **한 번 절사**. per-share 계산 금지 (현금 창조/소멸).
절사(원 미만 버림)는 법정 관례로 추정 — adverse 라운딩 아님. **실제 브로커 정산 명세로 검증 플래그.**
산술은 BigInt (세율은 bp 정수로 표현: 15bp → `grossMinor × 15n / 10_000n` 후 절사).

### D5 — money-conservation property와의 계약: 세금은 명시적 유출 leg
현재 sell fold: `cash += grossMinor` (`journal.ts:755`). 변경 후: `cash += grossMinor − taxMinor`.
property의 독립 오라클이 세금을 모르면 **보존 위반처럼 보이거나(거짓 양성) 조용한 차감을 못
잡는다(거짓 음성)**. 계약:

1. 오라클이 (quantity, price, venue, instrument 종류, eventTime)에서 세금을 **독립 재계산**
2. 이벤트 저장액(`costs.sellTransactionTaxMinor`)과 **항등 비교** — 어긋나면 위조/드리프트
3. 보존 항등식에 세금을 유출 leg로 편입: `Δcash + Δposition가치 + Σtax = 0` 형태
4. 검증 fold(`journal.ts:313`)에도 재계산 일치 검사 추가 — 위조 fill이 세금을 빼먹고 들어오는
   것을 경계에서 거절 (기존 limit guard 이중 방어와 같은 패턴)

## 2. 접합 지점 (실측 seam)

| 위치 | 변경 |
|---|---|
| `contracts.ts` `PaperFill` | `costs?` 필드 (D2) |
| `simulator.ts:174` fill 구성 | 세금 계산해 저장. 매수·비과세 instrument는 필드 생략 |
| `journal.ts:313` 검증 fold | costs 재계산 일치 검사 (불일치 = `invalid_fill`) |
| `journal.ts:745-755` 적용 fold | sell credit에서 `taxMinor` 차감 |
| 신규 `krx-transaction-tax.ts` | D3 테이블 + 순수 함수 (network-off static 번들) |
| `tests/property/money-conservation.property.test.ts` | D5 오라클 확장 |
| T9 리포트 | gross vs net 수익률 (tax drag 한 줄) — 차별점 표면 |

백테스트(T8)와 실시간 모의(T11)는 **같은 fill 이벤트 경로**를 쓰므로 한 번 편입되면 양쪽 자동 적용
— "같은 엔진" 설계가 여기서 실제로 돈을 번다.

## 3. 비범위 (명시적)

- **매수측 세금** — 없음 (한국 증권거래세는 매도만)
- **브로커 수수료** — KIS 계좌 유형별 상이. v1은 0 유지, config 주입 자리만 (`CostPolicy` 확장점)
- **양도소득세** — 대주주/해외주식 과세는 체결 회계가 아니라 리포트 밖 (v2도 미정)
- **미국장 SEC fee** — 대상 시장 미정 (pivot §9-2). venue별 스케줄 확장점만 D3 테이블 구조에 내재
- **VI·상한가** — 세금 아님. T8 market-rules 별도 스케치

## 4. 구현 전 검증 체크리스트 (미검증 사실 플래그)

- [x] 2026 세제 개정 여부 — **확인됨 (2026-07-24)**: KOSPI 0.05%+0.15%·KOSDAQ 0.20%,
      2026-01-01 양도분부터 (웹 3소스 교차, 테이블 반영됨)
- [x] ETF/ETN 매도 증권거래세 면제 — **확인됨 (2026-07-24)**: 다수 증권사 공식 가이드 일관
      (Kodex·신한·대신·한투 ETN). D3의 instrument 분기 필요성 확정
- [ ] D3 세율 테이블 1차 출처 대조: 법령(증권거래세법 탄력세율)/국세청 원문 — 웹 기사는 2차 출처
- [ ] 절사 규칙: 실제 KIS 정산 명세 1건으로 확인 (원 미만 버림 여부)
