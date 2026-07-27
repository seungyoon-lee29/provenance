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

## OF-10. tier-gate 는 "뒤 커밋이 해소한 pending" 을 표현할 수 없다 — **닫힘 (2026-07-27)**

- **무엇이었나**: 축 값은 그 커밋에 실재하는 경로여야 한다(OF-2 규칙, 옳다). 그런데 적대
  리뷰·blind 산출물은 원래 변경보다 **뒤 커밋**에서 생긴다. 앞 커밋이 뒤 커밋의 파일을
  가리킬 방법이 없어 `pending` 이 남고, 두 커밋이 함께 들어오는 PR 범위 전체가 red 였다 —
  범위로 보면 해소됐는데 커밋으로 보면 미해소다. **라운드 4→5 에서 두 번째로 걸렸다.**
- **어떻게 닫았나**: 별도 문법. `Resolves-Tier: <앞 커밋> (<축>=<이 커밋에 실재하는 경로>)`.
  `--range` 가 범위 안에서 그 축의 pending 을 상쇄한다. 검증 셋 — ① 대상 커밋이 이 범위 안
  ② 경로가 선언한 커밋에 실재 ③ 축 이름이 넷 중 하나. **"나중에 함"은 여전히 못 쓴다.**
  `waived:` 로 덧칠하지 않은 이유가 이것이다: 그러면 그 값이 "안 함"과 "뒤에서 함" 두 뜻을
  지고, pending 2층으로 닫으려던 구멍("나중이 없으면 그냥 안 한 것")이 다시 열린다.
- **판별력**: negative-control 41 → **45 케이스 0 fail**. 범위 밖 대상 → red, 없는 경로 →
  red, 정상 해소 → green, 그리고 **선언이 없으면 pending 은 그대로 red** — 마지막 것이
  핵심이다(상쇄가 무조건 통과로 새지 않는다는 증거).
- **남기는 것 (히스토리 재작성 안 함)**: 라운드 2 커밋(`0878226`)의 두 축은 이 문법이 생기기
  전에 `waived:라운드 3 에서 실행·기록` 으로 통과시켰고 그대로 둔다. 세 번째 SHA 이동을
  만들 값이 없고, 위험(후속이 그 형태를 모방하는 것)은 이제 올바른 문법이 존재하고 여기
  기록이 있는 것으로 상쇄된다. **다만 그 커밋을 선례로 인용하지 말 것.**

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

## OF-5. staged-tree-check 에 CI 대응물이 없다 — **닫힘 (2026-07-27)**

- **무엇이었나**: 게이트가 `.husky/pre-commit` 에만 있어 `--no-verify`·`prepare` 를 안 돈
  클론·웹 UI 커밋이 통째로 지나쳤다. tier-gate 가 같은 이유로 `--range` 를 받은 것과 같은 결함.
- **어떻게 닫았나**: `staged-tree-check.sh --range A..B` — 범위의 **각 커밋** 트리를
  `git archive` 로 꺼내 typecheck·lint. CI `pr-fast` 에 tier-gate 바로 뒤로 배선.
  로컬이 "이 커밋의 트리"를 보는 것을 원격에서 "들어오는 모든 커밋의 트리"로 넓힌 것이다 —
  **"브랜치 끝이 초록"과 "모든 커밋이 초록"은 다르고, bisect·revert 는 후자를 가정한다.**
- **비용 통제 (조용히 자르지 않는다)**: 정적 층에 영향을 줄 수 없는 커밋(문서·셸만)은
  건너뛰고 **건너뛴 SHA 를 찍는다**. 검사 대상이 20개를 넘으면 잘라내는 대신 red 로 멈추고
  범위를 좁히라고 말한다 — 자르면 "전부 검사했다"로 읽힌다.
- **판별력**: negative-control 38 → **40 케이스 0 fail**. `--range` 의 fail-closed 2건
  (해석 불가 ref / 인자 없음) 추가. 트리 검사 자체의 판별력은 기존 `--tree-dir` 2건이 증명한다.
- **알려진 천장**: `--range` 도 CI 가 실제로 돌아야 의미가 있다. 이 저장소는 지금
  `origin/main` 대비 33 커밋 ahead 이고 그것들은 CI 를 거치지 않았다(OF-4).

---

## OF-6. 예약(reserved)이 잔고에 묶여 있지 않다 — 분할이 어포더빌리티를 우회한다 — **닫힘 (2026-07-27, 라운드 6)**

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
- **원장 자기 정정 (라운드 6)**: 위 "기전" 이 `splitPrice` 를 **올림**이라 적은 것은 사실이
  아니다. 실제로는 `Math.round` 다(반올림 half-up). 부풀리기만 하는 것이 아니라 **양쪽으로
  샌다** — 1¢ 를 3:1 로 나누면 `round(0.33)` = 0 이 되어 예약이 통째로 사라진다. 이쪽이 더
  나쁘다(묶여야 할 현금이 아무 엔트리 없이 풀린다).
- **어떻게 닫았나 (라운드 6)**: 분할 변환을 `applySplitToOrder` 하나로 뽑아 fold 와
  `validateSystemBody` 가 **같은 것을** 보게 했다. 둘의 divergence 가 이 결함을 만들었다 —
  경계는 `payload.limitPrice` 를 보는데 fold 는 `reservation.unitPrice` 를 고쳤다.
- **폐기된 1차 시도 (적대 리뷰 F-1 이 죽였다)**: 처음에는 예약 가치의 **주문별 정확 보존**을
  요구하고 위반을 `reservation_not_conserved` 로 거부했다. 홀수 센트 단가가 전부 걸렸다 —
  **2:1 의 50%, 3:1 의 67%, 4:1 의 75%** 가 거절됐고, 100주 @ $101.03 같은 평범한 주문 하나가
  분할 자체를 막았다. 착수 전 사용자에게 고지한 위험은 "1센트 지정가"였는데 실제 범위는
  절반이었다 — **틀린 전제 위에서 받은 결정**이라 되돌렸다.
- **지금 서 있는 규칙**: 분할은 예약을 **모자라게 만들지 않고**, 그 예약이 **자기 잔고를 넘지
  않을 때만** 받는다.
  ① 예약 단가는 **올림**(`Math.ceil`)으로 양자화한다 — 예약은 현금 보유분이고 내림하면 그
  주문을 못 덮는다. 지정가는 여전히 반올림이다(매매 지시이지 보유분이 아니다).
  ② 분할 후 통화별 `합계 reserved > balance` 면 **`reservation_exceeds_balance`**.
  합계는 이 분할이 건드리지 않는 주문까지 포함한다 — 천장은 계정 전체의 사실이다.
  원 공격이 깨뜨린 조건이 정확히 이것이었다(잔고 $1,000 고정, 예약 2^53).
- **대가**: 예약이 수학적 보존값보다 주당 1 minor unit 미만 더 잡힌다. 계정 자기 돈이고
  공개 숫자 `reserved` 에 보인다. 정직한 분할의 거절률은 0 이다.
- **수량 예약(매도)은 현금 천장이 안 본다**: 예약이 주식 수이고 포지션도 같은 비율로 커지므로
  5주 → 10주 는 정직한 결과다.
- **sub-minor 지정가 거부는 양쪽 다**: 분할 후 지정가가 1 minor unit 미만이면 어떤 양수
  체결로도 못 채우는 주문이 남는다. 한때 매도 전용으로 좁혔다가 되돌렸다 — 지정가는 반올림,
  예약 단가는 올림이라 둘이 갈라지므로 현금 천장이 이 경우를 함의하지 않는다.
- **딸린 회귀 수정 (F-2)**: `validPayload` (`service.ts`) 가 `orderType:"market"` 에
  `limitPrice` 가 붙은 주문을 통과시켰다. 그 주문은 예약 단가와 지정가가 다른 수라 분할이
  둘을 갈라놓는다. 근본 원인에서 막았다 — 시장가는 `limitPrice` 를 가질 수 없다.
- **안전정수**: 분할 후 포지션·주문 수량이 2^53 밖이면 `invalid_adjustment`. 옛 술어
  `Number.isInteger` 는 3×2^52 를 통과시킨다 — "쪼개지지 않았다"와 "더 이상 셀 수 없다"를
  구분하지 못했다.
- **판별력**: 새 가드를 하나씩 죽여 각각 red 확인. 원 재현(1¢ 주문 + 2:1 분할 반복)은 예약이
  두 배씩 자라다 **잔고를 넘는 순간 멈추고**, 멈출 때까지 매 단계 `reserved ≤ balance` 가
  유지된다.
- **남는 대가**: OF-11.

---

## OF-11. 올림 예약의 대가 — 분할마다 계정 현금이 조금씩 더 묶인다

- **출처**: OF-6 라운드 6. 결정이 아니라 **선택의 대가**로 기록한다.
- **무엇인가**: 분할 후 예약 단가를 올림하므로, 예약이 수학적 보존값보다 **주당 1 minor unit
  미만** 더 잡힌다. 100주 @ $101.03 의 2:1 은 $10,103.00 → $10,104.00 로 $1 더 묶는다.
  분할을 반복하면 이 나머지가 누적된다.
- **왜 이 방향인가**: 반대 방향(내림)은 예약이 자기 주문을 못 덮게 만들고, 그건 예약이 존재하는
  이유 자체를 무너뜨린다. 정확 보존은 정직한 분할의 절반을 거부해서 폐기됐다(OF-6 참조).
  **더 잡는 것은 계정 자기 돈이고 공개 숫자 `reserved` 에 보인다** — 조용하지 않다.
- **미해결인 것**: 이 나머지를 되돌리는 명시적 경로가 없다. 주문이 체결되거나 취소되면 예약이
  통째로 풀리므로 영구 손실은 아니지만, **열려 있는 동안 묶인 금액이 원장의 어떤 엔트리로도
  설명되지 않는다**. "왜 $1 이 더 묶였나"에 답하려면 분할 엔트리와 올림 규칙을 알아야 한다.
- **한계는 잔고**: 나머지가 아무리 쌓여도 `reservation_exceeds_balance` 가 잔고에서 멈춘다.
  즉 무한 증가는 아니고, 최악은 "그 계정이 더 이상 신규 주문을 못 낸다"이다.
- **고치려면**: 올림 나머지를 **명시적 엔트리로** 기록해 `reserved` 의 모든 minor unit 이
  엔트리로 설명되게 한다. 새 엔트리 종류라 최상위 tier 다.

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
