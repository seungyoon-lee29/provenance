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
  3. `fba3642`(현 `14cf6de`) 의 `adversarial=tests/a+tests/b` — **옳은 red 다.** 축 하나에 위치 하나여야
     기계가 따라갈 수 있다. → 아래 미결 참조.

### OF-2 에서 파생된 미결 — **해소 (2026-07-27, `filter-branch`)**

두 커밋의 트레일러를 고쳤다. 트리는 동일하고(`git diff` 빈 출력) `--range` 는 rc=0 이다.
SHA 는 재작성으로 전부 바뀌었다 — 옛 SHA(`fba3642`·`c33909f`·`d1c2264` 등)를 인용한 기록은
이 줄 이후로 무효다.

| 옛 SHA → 새 SHA | 고친 것 |
| --- | --- |
| `fba3642` → `14cf6de` | `adversarial=a+b` → 경로 하나(`tests/t10-blind-mcp.test.ts`) |
| `c33909f` → `0878226` | `adversarial=pending, blind=pending` → 사유 있는 면제 (아래 OF-10 참조) |
| `d1c2264` → `a25be1a` | (메시지 변경 없음, 앞 커밋 재작성으로 SHA 만 이동) |

---

## OF-10. tier-gate 는 "뒤 커밋이 해소한 pending" 을 표현할 수 없다

- **출처**: OF-2 를 닫으면서 부딪힘 (2026-07-27)
- **문제**: 축 값은 **그 커밋에 존재하는 경로**여야 한다(`git cat-file -e $sha:$path`).
  라운드 2 커밋(`0878226`)의 적대·blind 축 산출물은 라운드 3 커밋(`a25be1a`)에서 생겼으므로
  앞 커밋이 뒤 커밋의 파일을 가리킬 방법이 없다. 그런데 `pending` 을 남기면 두 커밋이 함께
  들어오는 PR 범위 전체가 red 다 — **범위로 보면 해소됐는데 커밋으로 보면 미해소다.**
- **지금 한 것**: `waived:라운드 3 (d1c2264) 에서 실행·기록 — 이 커밋 시점엔 산출물이 아직 없다`.
  사실이고 통과한다. 다만 `waived:` 의 원래 뜻은 "안 할 것이고 사유가 있다"인데 여기서는
  "뒤에서 했다"로 쓰였다 — **의미가 둘이 됐다.** 그것이 이 항목의 존재 이유다.
- **왜 위험한가**: 이 이중 의미를 방치하면 `waived:나중에 함` 이 정당해 보이고, 그건
  stage-3 이 pending 2층으로 닫으려던 바로 그 구멍("나중이 없으면 그냥 안 한 것")이다.
- **다음 (둘 중 하나)**:
  1. 뒤 커밋에 `Resolves-Tier: <앞 SHA> (<축>=<경로>)` 트레일러를 두고, `--range` 가 범위
     안에서 pending 을 상쇄하게 한다. 정확하지만 새 기계다.
  2. `waived:` 를 쪼갠다 — `waived:` (안 함) / `deferred:<커밋 또는 티켓>` (뒤에서 함).
     싸고, 최소한 두 의미가 문법에서 갈린다.
  · 어느 쪽이든 **음성 대조군에 "deferred 가 실재하지 않는 곳을 가리키면 red" 를 넣어야**
    한다. 안 그러면 지금 pending 이 겪은 일을 그대로 반복한다.

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
