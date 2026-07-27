# 미해결 finding — 커밋으로 닫히지 않은 것

이 파일의 목적은 하나다: **초록인데 안 고쳐진 것을 초록 뒤에 숨기지 않는다.**
각 항목은 어디서 나왔는지, 왜 지금 안 고쳤는지, 고치려면 어떤 게이트가 걸리는지를 적는다.

---

## OF-1. 0주로 사이징된 진입은 완전히 침묵한다

- **출처**: 다른 세션의 blind test-authorship, `tests/t10-blind-strategy.test.ts` (2026-07-27)
- **재현**: `backtest run --series <fixture> --strategy buy_and_hold --cash 10540`
  → `fillCount=0 orders=0 refusals=[]`. 종가 10,000 · 기본 `cashFraction` 0.95.
  불일치 구간(이 픽스처): 현금 10,527~10,554, `cashFraction` 1 이면 10,001~10,024.
- **기전**: `strategy-catalog.ts:155` `affordableQuantity` 가 예약가(종가 × (1+슬리피지 bps)
  올림-틱)로 나눠 0 을 얻으면 `buy_and_hold` 가 액션을 아예 안 만든다.
  `refusals` 는 **제출된 액션이 거절될 때만** 채워지므로(`backtest-runner.ts:329`)
  기록될 사건이 없다. SKILL.md 황금원칙 3 의 탈출구("fillCount 0 이면 orders 를 봐라")가
  이 경우엔 성립하지 않는다 — orders 도 비어 있다.
- **2026-07-27 에 한 것**: 계약 쪽만 고쳤다. `cashFraction` 설명이
  `floor(cash*f/close)` 를 **상한**으로 명시하게 했고(`strategy-catalog.ts:133`),
  블라인드 테스트를 그 상한을 집행하는 형태로 좁혔다. 엔진은 설계대로 동작하며
  그 근거는 `strategy-catalog.ts:113-130` 에 이미 적혀 있었다.
- **안 고친 것**: 침묵 자체. 고치려면 `StrategyAction` 에 미진입 신호를 추가하고
  runner·리포트·SKILL.md 를 따라가야 한다 = **guarded 경로 공개 계약 변경 → 최상위 tier**
  (적대 리뷰 + blind 저자). 별도 티켓으로 다뤄야 할 크기다.
- **더 싼 대안 (같이 검토할 것)**: 리포트가 `maxSlippageBps` 를 공개하면
  호출자가 예약가를 정확히 계산할 수 있어 상한이 등식이 된다. 필드 1개 추가(가산적)이지만
  이것도 리포트 shape 변경이라 guarded 다.

---

## OF-2. 트레일러 축 값이 검증되지 않는다

- **출처**: stage-3 자기 신고 (`progress/stage-3.md`)
- **재현**: `Tier: top (adversarial=x, blind=x, standards=x, prior-decisions=x)` → rc=0. 빈 값도 rc=0.
- **영향**: stage-3 이 넣은 pending 검사가 한 글자로 우회된다.
- **다음**: 축 값을 ① 실재 경로 ② `waived:<비공백 사유>` ③ `none-found`(prior-decisions 전용)
  셋으로 제한.

---

## OF-3. fold 의 현금 잔고 "합" 은 2^53 미집행 (라운드 1 시점 기록)

- **출처**: stage-1 실측
- **상태**: **라운드 2 가 다루는 중** (`journal.ts` 워크트리 변경분). 닫히면 이 항목 삭제.

---

## OF-4. `main...origin/main [ahead N]` — push 안 된 커밋은 CI 를 안 거쳤다

- **출처**: stage-3
- **상태**: push 는 사람 소유 단계. 에이전트가 처리하지 않는다.
