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

## OF-2. 트레일러 축 값이 검증되지 않는다 — **닫힘 (2026-07-27)**

- **출처**: stage-3 자기 신고 + 이 세션의 실측 2건
- **무엇이었나**: 형식 정규식이 축의 **존재**만 봤다. 값은 무엇이든 통과했다.
  - `Tier: top (adversarial=x, blind=x, standards=x, prior-decisions=x)` → rc=0. 빈 값도 rc=0.
  - pending 검사가 `축=pending` **리터럴 매칭**이라, 라운드별 상태를 정직하게 둘 다 적은
    `adversarial=<경로> (라운드 1) / pending (라운드 2)` 가 통과했다. 숨길 의도 없이 쓴
    서술이 우회가 됐다 — 이 결함은 악의를 전제하지 않는다는 것이 핵심이다.
- **어떻게 닫았나**: 축 값을 넷 중 **하나로만** 제한하고 행 끝까지 anchor 한다.
  ① 실재하는 경로 (`#앵커`·`:줄` 접미 허용, 축 하나에 경로 하나)
  ② `pending` ③ `waived:<비공백 사유>` ④ `none-found` (prior-decisions 전용)
  경로는 **실재까지** 본다 — 없는 파일을 적는 것은 pending 을 감춘 것과 같고, 그 형태가
  이 저장소에 실제로 있었다(`progress/stage2-persistence.md` — 루트 기준이 아니라 어디에도 없다).
- **판별력**: `negative-control.sh` 에 7케이스(garbage·빈값·없는 경로·공백 waived·
  none-found 오용·서술 섞임 + 양성 대조군). 38 ok / 0 fail.
- **알려진 천장**: 파일이 존재하는지만 본다. 그 파일에 실제로 그 축의 기록이 있는지는
  사람·리뷰 몫이다. 그리고 2026-07-27 이전 커밋은 이 규칙 이전에 쓰인 트레일러라
  소급 판정하지 않는다(`AXIS_CUTOFF`).
- **이 게이트가 스스로 잡은 것 (넣자마자, 2026-07-27)**:
  1. 게이트가 슬래시를 요구해 루트 파일(`eslint.config.mjs`)에 **거짓 red** — 게이트를 고쳤다.
  2. `file:line` 접미를 경로로 못 읽음 — 게이트를 고쳤다.
  3. `fba3642` 의 `adversarial=tests/a+tests/b` — **옳은 red 다.** 축 하나에 위치 하나여야
     기계가 따라갈 수 있다. → 아래 미결 참조.

### OF-2 에서 파생된 미결 — 커밋 메시지 2건 (히스토리 재작성 필요)

`--range` 가 지금 red 인 커밋 둘. 에이전트 2건(라운드 2 적대 리뷰·blind 저자)이 도는 중이고
그 결과가 나오면 `c33909f` 의 pending 축도 어차피 고쳐야 하므로, **재작성은 한 번에** 한다.

| 커밋 | 축 | 고칠 값 |
| --- | --- | --- |
| `fba3642` | `adversarial=tests/t10-blind-mcp.test.ts+tests/t10-blind-strategy.test.ts` | 경로 하나로 — `tests/t10-blind-mcp.test.ts` (strategy 쪽은 `blind=` 축이 이미 가리킨다) |
| `c33909f` | `adversarial=pending`, `blind=pending` | 에이전트 결과의 기록 위치로 |

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

## OF-6. 예약(reserved)이 잔고에 묶여 있지 않다 — 분할이 어포더빌리티를 우회한다

- **출처**: 라운드 2 적대 리뷰 finding #2 (High). 메인이 재현했다.
- **재현**: `probe-reservation.ts` — seed $1000, 1주/1센트 시장가 매수 2건, 2:1 분할 53회.
  전 엔트리가 `validateSystemBody` 를 통과한다.
  ```
  any refusal from validateSystemBody: NONE — every entry accepted
  balance(minor)      = 100000
  folded cash.reserved= 9007199254740992   exact sum = 9007199254740993n
  reserved is EXACT?  = false
  reserved > balance? = true
  availableMinor as coded = 100000 / exact 99999n / fail-open by 1n
  ```
  1회로도 움직인다: `reserved before split = 2` → 3:1 분할 ACCEPTED → `reserved after = 3`.
- **기전**: 라운드 2 가 예약 가드를 생략한 근거는 "submit 의 어포더빌리티가
  `required ≤ balance − reserved` 를 강제하므로 잔고를 막으면 예약이 따라 막힌다" 였다.
  **`corporate_action_applied` 가 살아있는 예약을 submit 이후에 다시 쓰고 어포더빌리티를
  재실행하지 않는다.** `splitPrice` 는 올림이라 `newQty × newPrice > oldQty × oldPrice` 로
  단조 증가하고, `numerator` 에 상한이 없으며, sub-minor 거부는 `payload.limitPrice` 만
  덮어 시장가 주문은 무제한이다.
- **즉 라운드 2 의 명시적 근거가 거짓이다.** 코드가 아니라 논증이 틀렸으므로 주석·커밋
  메시지도 함께 고쳐야 한다.
- **다음**: `corporate_action_applied` 가 예약을 다시 쓸 때 (a) 새 예약이 안전정수인지
  (b) `reserved ≤ balance` 가 유지되는지 재검증. 분할 자체를 거부할지 예약을 재계산할지는
  설계 판단이다 — 분할은 시장 사실이므로 거부가 옳은지부터 물어야 한다.

---

## OF-7. fold 의 정수 누산기 3개 중 **원가(costBasis)** 가 무가드

- **출처**: 라운드 2 적대 리뷰 finding #3 (Med). 메인이 재현했다.
- **재현**: `probe-basis.ts`
  ```
  refusals from validateSystemBody: NONE — every entry accepted
  stored costBasis.minorUnits = 13500000000000000   exact = 13500000000000001n
  isSafeInteger(costBasis) = false   drift = -1n
  cash balance(minor) = 4499999999999999 safe? true   ← 현금 불변식은 내내 성립했다
  ```
- **기전**: fold 자신의 헤더가 "cash, cost basis and reservations" 셋을 정수 누산기로
  선언하는데 라운드 2 는 **현금만** 가드했다. `costBasis.minorUnits + grossMinor` 에 상한이
  없고, 배당이 원가를 건드리지 않고 잔고만 채워주므로 매수→배당→매수로 원가만 천장을 넘긴다.
  드리프트한 원가는 BigInt relief 와 `realizedSales` P&L 로 흘러간다.
- **이것이 라운드 2 불변식 서술의 진짜 결함이다**: "현금 총액"으로 좁힌 불변식은 참이면서도
  원장의 정확성을 보장하지 못한다. 불변식을 누산기 셋 전체로 다시 써야 한다.

---

## OF-8. `seedCash` 가 비면 genesis 가 두 번 된다

- **출처**: 라운드 2 적대 리뷰 finding #6 (Low). 메인이 재현했다.
- **재현**: `probe-misc.ts`
  ```
  (A) state after empty genesis: cash.size/orders.size = 0 0
  (A) validateSystemBody(second account_opened, seed $1M) = ACCEPTED
  (A) folded balance after 2nd genesis = 100000000
  ```
- **기전**: `// Genesis happens exactly once per account.` 가 `cash.size > 0 || orders.size > 0`
  로 구현돼 있다. 빈 seed 는 둘 다 0 으로 남기므로 다른 dedupe 키의 두 번째 genesis 가 통과해
  현금을 찍어낸다. 빈 seed 는 도달 가능한 형태다(`src/operations/catalog.ts` 의
  `paper.account` 가 `seedCash: []` 로 서비스를 만든다).
- **라운드 3 에서 안 닫은 이유**: `#owners` 는 이미 알고 있지만 `validateSystemBody` 는
  의도적으로 **fold 의 순수 함수**다. genesis 마커를 접힌 상태에 넣는 것은 상태 shape 변경이라
  별도 tier 다. 주석은 사실대로 좁혀 뒀다.

---

## OF-9. 모르는 통화가 조용히 scale 100 을 받는다

- **출처**: 라운드 2 적대 리뷰 finding #4 의 부수 실측
- **재현**: `[{"amount":1000,"currency":"XYZ"}]` → ACCEPTED, 잔고 100000
- **상태**: `currencyMinorUnitScale` 의 문서화된 ponytail 범위("두 통화가 제품 범위, 세 번째가
  오면 표")와 일치하므로 **결함이 아니라 알려진 범위**다. 다만 genesis 가 통화를
  검증하지 않는다는 사실은 여기 적어 둔다 — 세 번째 통화가 들어오는 날 이 줄이 근거다.

---

## OF-4. `main...origin/main [ahead N]` — push 안 된 커밋은 CI 를 안 거쳤다

- **출처**: stage-3
- **상태**: push 는 사람 소유 단계. 에이전트가 처리하지 않는다.
