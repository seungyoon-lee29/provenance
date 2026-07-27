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
- **같은 병의 두 번째 얼굴 (2026-07-27 실측)**: pending 검사는 `grep -oE '(축)=pending'`
  즉 **리터럴 매칭**이라 축 값에 뭐라도 앞에 붙이면 안 걸린다. 실측:
  `adversarial=progress/stage-1.md (라운드 1) / pending (라운드 2)` → rc=0.
  숨길 의도 없이 "둘 다 적자"고 쓴 형태가 게이트를 통과했다 — 악의 없는 서술이
  우회가 되는 것이 이 결함의 성질이다. 축을 `pending` 하나로 낮춰 커밋을 고쳤다.
- **다음**: 축 값을 ① 실재 경로 ② `waived:<비공백 사유>` ③ `pending` ④ `none-found`
  (prior-decisions 전용) 넷 중 **하나만** 오도록 제한(전체 anchor). 그 하나가 garbage·
  빈값·pending 우회·허위 위치를 동시에 닫는다.

---

## OF-3. fold 의 현금 잔고 "합" 은 2^53 미집행 — **닫힘 (2026-07-27, 라운드 2)**

- **출처**: stage-1 실측
- **어떻게 닫았나**: fold 안이 아니라 **append 경계**에서 닫았다
  (`validateSystemBody` 의 `account_opened`·`dividend_applied`·`fill_applied`).
  fold 가 의도적으로 재검증하지 않는다는 2026-07-25 결정을 되살리지 않기 위해서다.
  불변식은 "현금 총액이 안전정수 영역을 벗어나지 않는다" 하나로 정리됐고,
  그 영역 안에서는 fold 의 덧셈·뺄셈이 전부 정확하다.
- **남는 정확한 서술**: fold 자신은 여전히 검사하지 않는다. 원장에 이미 적힌 엔트리는
  재해석되지 않으므로, **이 커밋 이전에 기록된** 안전영역 밖 잔고가 있다면 그것은
  이 가드가 잡지 않는다. 마이그레이션은 없다(저장 포맷 무변경).
- **회귀 오라클**: `tests/t10-round2-money-ceiling.test.ts` 15케이스.

---

## OF-5. staged-tree-check 에 CI 대응물이 없다

- **출처**: 이 게이트를 넣으면서 스스로 신고 (2026-07-27)
- **문제**: `scripts/gates/staged-tree-check.sh` 는 `.husky/pre-commit` 에만 있다. 훅은 로컬
  산물이므로 `--no-verify`·`prepare` 를 안 돈 클론·웹 UI 커밋은 무검사로 통과한다.
  tier-gate 가 2026-07-27 에 받은 `--range` 대응물과 정확히 같은 결함이다.
- **다음**: PR 범위의 각 커밋을 체크아웃해 typecheck·lint 를 도는 CI 스텝.
  비용이 커밋 수에 비례하므로 범위 상한을 함께 정해야 한다.

---

## OF-4. `main...origin/main [ahead N]` — push 안 된 커밋은 CI 를 안 거쳤다

- **출처**: stage-3
- **상태**: push 는 사람 소유 단계. 에이전트가 처리하지 않는다.
