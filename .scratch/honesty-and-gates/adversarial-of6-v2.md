# 적대 리뷰 v2 — OF-6 수정의 **대체안** (`ceil` 예약 단가 + `reservation_exceeds_balance`)

- **대상**: 워킹트리 `src/modules/paper-trading/internal/journal.ts`
  (md5 `9072c92a53d6fcf485155835975bd064`),
  `.../service.ts` (md5 `f9454ab30a1ccc4825bd0399775c5812`),
  `tests/f8-journal-boundary.test.ts`, `tests/t10-round2-money-ceiling.test.ts`,
  `tests/t10-blind-of6.test.ts`
- **일시**: 2026-07-27. v1(`adversarial-of6-v1.md`)의 F-1·F-2 채택 → 설계 교체 → 그 교체분을 같은 tier 로 재공격.
- **판정 기준**: `file:line` + 재현 명령이 있는 것만 **접수**. 나머지는 §의견.
- **리뷰어가 만진 것**: 추적 파일 0개(`git diff --stat` 로 확인, 이 문서만 신규).
  프로브는 전부 스크래치패드에서 `npx tsx`, 뮤테이션은 격리 복사본(`git ls-files | tar`)에서.
- **주의**: 리뷰 도중(23:11, 23:13) 다른 세션이 `journal.ts` 와 `t10-blind-of6.test.ts` 를
  다시 썼다. 이 문서의 모든 수치는 **위 md5 기준으로 재실행해 다시 얻은 것**이다.

## 재현 환경 (저장소 루트에서)

```
SC=/private/tmp/claude-501/-Users-ian-workspace-provenance/a3e02c42-e669-4d91-9135-b021ce52aed3/scratchpad
npx tsx $SC/p1-ratchet.ts      # 폭주·단발 팽창
npx tsx $SC/p2-false-refusal.ts # 거짓 거절률
npx tsx $SC/p3-consume.ts      # 팽창한 예약의 소비·취소·타종목
npx tsx $SC/p4-negative.ts     # available < 0
npx tsx $SC/p5-ceil.ts         # 죽은 홀드
npx tsx $SC/p6-misc.ts         # 역분할·취소·상한 없는 numerator·사후조건 스윕
python3 $SC/mutate.py          # 뮤테이션 9종
```

`$SC/h.ts` 는 `tests/t10-blind-of6.test.ts` 의 하네스를 그대로 옮긴 것이다(다종목·다통화만 추가).

---

## 요약

원래 OF-6 공격(예약 2^53 폭주)은 **닫혔다** — `reservation_exceeds_balance` 가 잔고에서 멈춘다
(p1 A: 23번째 분할에서 `$83,886.08`, 24번째에서 거절). v1 의 F-2(market+limitPrice)도 **닫혔다**.
v1 의 F-1(정상 분할 50% 거절)은 **여유 현금이 있는 계정에서만** 닫혔다.

그런데 교체안은 세 가지를 새로 만들었고, 그중 둘은 **이 변경이 자기 주석에 써 놓은 근거가
실행으로 반증된다**는 종류다.

1. **F-1 (High)** — `ceil` 의 근거가 지정가 주문에서 **거짓**이다. 지정가는 내림(`round`),
   홀드는 올림(`ceil`) 이라 홀드가 **그 주문이 평생 쓸 수 있는 최대 금액보다 크다.**
   "a hold that rounded down would stop covering its order" 는 지정가 매수에서 성립하지 않는다.
   그리고 **`ceil` 을 `round` 로 바꿔도 스위트가 전부 초록이다** — 이 변경의 핵심 결정에
   테스트가 0개다.
2. **F-2 (High)** — "over-hold, by under one minor unit per share" 라는 경계 주장이
   **주식 수를 분할비만큼 늘리는 그 분할 자신**에 의해 무의미해진다. 단 한 번의
   `10,000,000:1` 분할이 **2¢ 홀드를 잔고 전액($100,000)로** 만들고, 그 상태는 **승인된다**.
   계정은 그 순간부터 $1 짜리 주문도 못 낸다.
3. **F-3 (Medium, 회귀 아님)** — 이 가드가 지키는 `reserved ≤ balance` 는 **계정 불변식이
   아니다.** 시장가 매수는 지정가 상한이 없어서, 예약 단가를 넘는 부분체결이 저널 경계를
   통과하고 `available` 이 **−$49.50** 이 된다. HEAD 에서도 같은 값으로 재현된다.
4. **F-4 (Medium)** — v1 F-1 의 잔여. 헤드룸이 `수량 × (분자−1)/분자` minor 미만인 계정에서는
   평범한 2:1 의 **50%가 여전히 거절**된다(헤드룸 0·50 minor 에서 100/200).
5. **F-5 (Low)** — `isExactMinor(gross)` 가드는 뮤테이션 생존. 공허하다.

---

## 접수된 finding

### F-1 (High) — `ceil` 의 근거가 지정가 주문에서 거짓이고, 그 결정에 테스트가 없다

- **위치**: `src/modules/paper-trading/internal/journal.ts:262-268` (근거 주석),
  `:288-290` (`limitPrice` 는 `Math.round`, `reservation.unitPrice` 는 `Math.ceil`)
- **주장 반박**: 주석은 *"the reservation unit price CEILS … a hold that rounded down would
  stop covering the order it exists for"* 라고 쓴다. **지정가 주문에서는 거짓이다.**
  같은 함수가 지정가를 `Math.round` 로 **내림**하므로, 그 주문이 체결로 쓸 수 있는 최대
  금액은 `분할 후 수량 × round(단가)` 다. `ceil` 홀드는 그보다 항상 **크거나 같다.**
  즉 `round` 로 내려도 "커버가 끊기는" 일은 지정가 주문에서 일어날 수 없고,
  `ceil` 은 **아무 것도 담보하지 않는 현금을 붙든다.**
- **재현** (`npx tsx $SC/p5-ceil.ts`):

  ```
  K) 3주 @ $1 → 3:1 → 9주 @ $0.33 | 예약 306 minor, 이 주문이 최대로 쓸 수 있는 돈 297 minor | 죽은 홀드 9
  K) 100주 @ $1 → 3:1 → 300주 @ $0.33 | 예약 10200, 최대 지출 9900 | 죽은 홀드 300
  K) 100주 @ $1 → 7:1 → 700주 @ $0.14 | 예약 10500, 최대 지출 9800 | 죽은 홀드 700
  L) 3주 @ $1.00 에 3:1 반복
    step1: qty=9   limit=33 reserved=306 maxSpend=297 죽은홀드=9
    step2: qty=27  limit=11 reserved=324 maxSpend=297 죽은홀드=27
    step4: qty=243 limit=1  reserved=486 maxSpend=243 죽은홀드=243
  ```

  죽은 홀드는 분할마다 **누적**된다(9 → 27 → 243). 어떤 원장 항목도 이 증가를 설명하지 않는다.
- **가드가 비어 있다는 증거 (뮤테이션 M2, `python3 $SC/mutate.py`)**:

  | 뮤테이션 | 결과 |
  | --- | --- |
  | **M2 `Math.ceil` → `Math.round`** | **1 failed = 격리본 기저치와 동일 → 전부 초록. 생존.** |

  격리본 기저치는 `1 failed (tests/gate-negative-control.test.ts)` — 복사본에서 `git` 레인이
  안 잡히는 환경 아티팩트이고 9종 뮤테이션 전부에서 동일하게 난다. 즉 **M2 는 아무 것도
  안 깨뜨린다.** `Math.round` 는 JS 에서 half-up 이라 `/2` 에서는 `ceil` 과 값이 같고,
  블라인드 스위트의 올림 케이스가 전부 2:1(`ceil(11001/2)=round(11001/2)=5501`)이라 갈라지지
  않는다. 두 양자화가 실제로 갈라지는 것은 나머지가 분자의 절반 미만일 때
  (`ceil(100/3)=34` vs `round(100/3)=33`)인데, 그 케이스가 스위트에 없다.
- **심각도 근거**: 돈을 잃지 않는다. 그러나 (a) 이 변경의 **가장 논쟁적인 결정**이고,
  (b) 그 결정의 문서화된 근거가 실행으로 반증되며, (c) 회귀를 잡을 것이 없다.
  이 저장소가 arch-1 에서 명문화한 실패("거짓 근거가 그대로 기록으로 남을 뻔했다")와 같은 형태다.

---

### F-2 (High) — "주당 1 minor 미만" 이라는 경계는 분할 자신이 무의미하게 만든다: 2¢ → 잔고 전액, 한 방에

- **위치**: `src/modules/paper-trading/internal/journal.ts:266-267` (경계 주장),
  `:416-425` (유일한 상한이 잔고라는 결정)
- **주장 반박**: 주석은 *"Ceiling can only over-hold, by under one minor unit per share"*
  라고 쓴다. 문장 자체는 참이지만 **주식 수가 상수가 아니다** — 같은 분할이 수량에
  `numerator/denominator` 를 곱한다. 따라서 실제 상한은 `(분할 후 수량) × 1 minor`, 즉
  **분할비에 비례해 무한히 커진다.** 코드에 `numerator` 상한은 없다(`:368` 은 양의 정수만 본다).
- **재현** (`npx tsx $SC/p1-ratchet.ts`, `npx tsx $SC/p3-consume.ts`).
  잔고 $100,000, 관측가 $0.01 의 시장가 매수 1주(예약 $0.02, 지정가 없음 → §3 의 veto 가 안 걸림):

  ```
  B) split 100:1        -> applied; reserved 후 $1        available $99,999
  B) split 1,000,000:1  -> applied; reserved 후 $10,000   available $90,000
  B) split 10,000,000:1 -> applied; reserved 후 $100,000  available $0
  B) split 10,000,001:1 -> refused/reservation_exceeds_balance
  ```

  ```
  F1) split 후 reserved=$100000 balance=$100000 available=$0
  F2) $1 짜리 다른 주문: {"status":"refused","reason":"insufficient_cash"}
  F3) 1e7주 @ $0.01 체결: {"status":"applied"} → balance=$0, position 1e7주, costBasis $100,000
  ```

  2센트어치 노출이 **한 개의 승인된 원장 항목**으로 계정 전액 홀드가 되고, 그 상태에서
  계정은 어떤 주문도 못 낸다. 그 주문이 체결되면 잔고 전액이 나간다.
- **2:1 반복판(원 OF-6 공격의 형태)**: `ceil` 이 단가를 1 minor 에 고정하고 `Math.round(0.5)=1`
  이라 지정가도 1¢ 에 고정된다 → gross 가 분할마다 **정확히 두 배**:

  ```
  1¢ 지정가 매수 1주: $0.01 → $0.02 → … → split#23 $83,886.08 → split#24 refused/reservation_exceeds_balance
  ```

  `tests/t10-blind-of6.test.ts:221-249` 가 이 폭주를 **기대 동작으로 고정**하고 있다
  (`expect(steps).toBe(23)`). 즉 폭주 자체는 설계 의도이고, 내가 접수하는 것은
  **주석이 그 크기를 "주당 1 minor 미만" 으로 서술한다는 점**과 **단발 분할로도 같은 결과에
  도달한다는 점**이다.
- **완화 (확인함)**: 되돌릴 수 있다. 주문 취소로 예약이 전액 해제된다
  (`p3-consume.ts` G: `취소 applied: reserved $100000 -> $0`). 그래서 Blocker 가 아니라 High.
- **HEAD 대조**: 같은 `10,000,000:1` 을 HEAD 에 걸면 `Math.round(2/1e7)=0` 으로 예약이
  **0 으로 증발**한다(OF-6 의 반대쪽 절반). 즉 교체안은 과소 홀드를 과대 홀드로 바꿨고,
  그 과대 홀드의 상한이 잔고 전액이다.

---

### F-3 (Medium, **회귀 아님** — HEAD 에서도 재현) — `reserved ≤ balance` 는 계정 불변식이 아니다

- **위치**: 이 변경이 세우는 사후조건 `journal.ts:423-425` vs 그것을 깨는 경로
  `src/modules/paper-trading/internal/journal.ts:549-559` (매수 체결 검사에
  **체결가가 예약 단가를 넘는지 보는 항이 없다**)
- **주장**: `reservation_exceeds_balance` 는 *분할 시점에만* `reserved ≤ balance` 를 세운다.
  시장가 매수는 지정가 상한이 없으므로, 예약 단가보다 비싼 **부분** 체결이 저널 경계를
  통과한다. 그러면 잔고는 체결가만큼 줄고 예약은 예약 단가만큼만 줄어 **`reserved > balance`**
  가 된다.
- **재현** (`npx tsx $SC/p4-negative.ts`, 분할 없음):

  ```
  I1) reserved=$991 balance=$1000 available=$9.00
  I2) 50주 @ $2.18 부분체결(예약 단가는 $1.01) -> applied
      reserved=$940.5 balance=$891 available=$-49.50
  ```

  분할을 끼워도 같다(J: `available=$-50.00`).
- **HEAD 대조** (`npx tsx $SC/p4-head.ts`, `git ls-files | tar` 로 뜬 HEAD 복사본):
  **완전히 동일한 수치**(`available=$-49.50`). 이 변경이 만든 결함이 아니다.
- **왜 접수하는가**: 이 변경의 근거 문단(`:416-422`)이 *"never past the cash that backs it"*
  를 성질로 서술한다. 그 성질은 다른 경로가 이미 깬다 — 즉 새 가드는 **불변식 집행자가 아니라
  한 지점의 검사**다. 근거 문단이 그것을 그렇게 말하지 않는다.
- **심각도**: Medium — 선행 결함이고 이 변경이 악화시키지 않는다. 다만 `available` 음수를
  소비하는 곳(`service.ts:378`, `journal.ts:557`, `simulator.ts:258`)은 전부 fail-closed 로
  읽는 것을 확인했다(음수 available → 전부 거절). 조용한 초과지출은 못 만들었다.

---

### F-4 (Medium) — v1 F-1 의 잔여: 헤드룸 없는 계정에서는 평범한 2:1 의 50% 가 여전히 거절된다

- **위치**: `src/modules/paper-trading/internal/journal.ts:423-425`
- **재현** (`npx tsx $SC/p2-false-refusal.ts`, 센트 1..200 × 수량 100, 매번 새 계정):

  | 헤드룸(`balance − reserved`) | 2:1 거절 |
  | --- | --- |
  | 0 minor | **100/200 (50%)** |
  | 50 minor | **100/200 (50%)** |
  | 100 minor | 0/200 |
  | 200 minor | 0/200 |
  | 10,000 minor | 0/200 |

  ```
  C) seed=$1000  order=1@$1.01 headroom=$998.99 -> 2:1 applied   (v1 은 여기서 거절했다)
  C) seed=$1.01  order=1@$1.01 headroom=$0.00   -> 2:1 refused/reservation_exceeds_balance
  C) seed=$101   order=100@$1.01 headroom=$0.00 -> 2:1 refused/reservation_exceeds_balance
  ```

  무관한 다른 종목 주문이 헤드룸을 먹어도 같다 (`p3-consume.ts` H):
  `AAPL 1주@$1.01 + 무관한 MSFT 99899주@$0.01 (reserved=$1000=balance) -> AAPL 2:1 refused`.
- **계정 전체 합산 자체는 거짓 거절이 아니다**: 손 안 댄 주문의 홀드는 실제로 붙들려 있는
  현금이므로 합계에 넣는 것이 옳다. 거절을 만드는 것은 **합산이 아니라 `ceil` 나머지**다.
  (뮤테이션 M8 = 손 안 댄 주문을 합계에서 빼기 → `t10-blind-of6` red. 이 항목은 비어 있지 않다.)
- **피해**: v1 F-1 과 같다 — 분할이 통째로 거절되므로 **포지션도 안 쪼개지고**, 재전달해도 같은
  이유로 또 거절된다(영구 불일치). 다만 발생 조건이 "홀수 센트" 에서 "홀수 센트 **AND** 현금
  거의 소진" 으로 좁아졌다. 그래서 High → Medium.

---

### F-5 (Low) — `isExactMinor(gross)` 가드는 공허하다

- **위치**: `src/modules/paper-trading/internal/journal.ts:413`
- **재현**: `python3 $SC/mutate.py` → `M5 gross 안전정수 가드 제거: 1 failed`
  = 격리본 기저치와 동일 → **전부 초록. 생존.**
- 다른 두 안전정수 가드(`:378` 포지션, `:395` 주문 수량)는 죽는다(M6·M4). 이것만 안 죽는다.
  잔고 천장이 먼저 잡기 때문에 도달 불가일 가능성이 높지만, **그 논증이 코드에도 테스트에도
  없다.** 도달 가능한 입력을 나는 못 만들었다 — 그래서 Low 이고, "지우라" 가 아니라
  "도달 불가면 그 근거를 쓰고, 아니면 테스트를 붙이라" 다.

---

## 뮤테이션 결과 전문

격리 복사본(`$SC/mut`) 기저치: `1 failed | 953 passed | 56 skipped`
(그 1건 = `tests/gate-negative-control.test.ts`, 복사본에서 `git` 이 안 잡히는 환경 아티팩트.
9종 전부에서 동일하게 나므로 아래 판정에서 뺀다.)

| 뮤테이션 | 결과 | 판정 |
| --- | --- | --- |
| M1 잔고 천장 제거 (`:424`) | 4 failed (f8-journal-boundary, t10-blind-of6) | **red** |
| **M2 `ceil` → `round` (`:289`)** | **1 failed = 기저치** | **생존 → F-1** |
| M3 sub-minor 지정가 veto 제거 (`:403-405`) | 6 failed | **red** |
| M4 주문 수량 안전정수 가드 제거 (`:395-397`) | 2 failed (t10-round2) | **red** |
| **M5 `isExactMinor(gross)` 제거 (`:413`)** | **1 failed = 기저치** | **생존 → F-5** |
| M6 포지션 안전정수 가드 제거 (`:378`) | 3 failed | **red** |
| M7 `validPayload` market+limitPrice 거부 제거 (`service.ts:453`) | 2 failed (t10-blind-of6) | **red** |
| M8 천장에서 손 안 댄 주문 제외 (`:407`) | 2 failed (t10-blind-of6) | **red** |
| M9 veto 를 매도에만 (v1 의 좁힘으로 되돌림) | 4 failed | **red** |

---

## 의견 (근거 없음 — 수정 근거로 쓰지 말 것)

- **O-1**: `numerator`/`denominator` 상한 없음. `1e21:1` 분할이 포지션·주문 없는 계정에
  `applied` 로 들어간다(`p6-misc.ts` O). 상태를 안 바꾸므로 무해해 보이나, **원장에
  의미 없는 항목이 영구히 남는 것이 문제인지**는 판단하지 않았다.
- **O-2**: `ceil` 이 정당화되는 경로는 시장가 매수뿐인데(지정가 상한이 없으므로), 거기서도
  "커버가 끊긴다" 는 서술은 정확하지 않다 — 저널 체결 검사가 예약 단가로 체결가를 묶지 않기
  때문이다(F-3). 시뮬레이터(`simulator.ts:258`)는 묶는다. 즉 `ceil` 의 실제 효용은
  "시뮬레이터가 살 수 있는 주식 수" 뿐인 것으로 보이나 **미검증**.
- **O-3**: `applySplitToOrder` 의 반환 타입이 여전히 `PaperOrderState` 부분집합의 수기 나열이다
  (v1 O-3 그대로). 현재 결함 아님.

---

## 내가 시도했지만 깨지지 않은 것

- **원 OF-6 공격(2^53 폭주)**: 닫혔다. `reserved` 는 잔고에서 멈추고, 안전정수 범위를 못 넘는다
  (p1 A). 잔고 자체가 `isRepresentableSeedCash` 로 2^53 아래에 묶여 있다.
- **`available` 을 분할로 음수로 만들기**: 못 했다. 분할 시점에 `reserved ≤ balance` 가 서고,
  그 뒤 잔고를 줄이는 유일한 항목(매수 체결)은 자기 예약 + 여유로 묶인다. 음수는 F-3 의
  **선행** 경로로만 만들었고, 그건 HEAD 도 같다.
- **`state.cash` 가 낡은 잔고인가**: 아니다. `corporate_action_applied` 의 fold arm 은 현금을
  건드리지 않는다(`journal.ts:1040-1067` 읽음). 같은 항목 안에서 잔고가 바뀌는 순서가 없다.
- **fold ↔ validator 발산**: 못 찾았다. 사후조건 스윕 1,598건(센트 1..400 × {2:1, 3:1, 5:2, 1:2})
  전부 위반 0 (`p6-misc.ts` P: `reserved > balance` 0건, 비정수 수량 0건, 지정가 0 통과 0건).
  주문 선택 술어가 양쪽 다 `reserving()` 로 같고, 손 댄 주문은 양쪽 다 `applySplitToOrder`
  하나를 부른다.
- **취소 축**: `cancellation: "confirmed"` 인 주문은 천장에도 fold 에도 안 들어가고 수량도
  안 바뀐다(`p6-misc.ts` N). `"requested"`/`"rejected"` 는 양쪽 다 살아있는 주문으로 센다.
- **역분할·다통화**: `1:2` 역분할은 단가를 곱하므로 반올림 손실이 없다
  (`4주@$1.01 → 2주@$2.02`, 예약 $4.04 그대로). 통화가 둘인 계정에서 예약 없는 통화 행은
  영향을 안 받는다(`p6-misc.ts` M).
- **(3) 양쪽 sub-minor veto 가 뭔가를 깼는가**: 아니다. 매도 쪽은 HEAD 와 같은 동작이고,
  매수 쪽 양성 대조군(`2¢ + 2:1 → 1¢`)이 통과한다(블라인드 스위트에 있음). M3·M9 둘 다 red.
- **(4) `validPayload` 좁힘이 뭔가를 깼는가**: 아니다. `grep -rn 'orderType: "market"' src tests`
  로 확인한 결과 `limitPrice` 를 같이 다는 곳이 프로덕션에 없고, 백테스트 전략도
  `strategy-catalog.ts:173` 이 `limitPrice` 없이 만든다. 백테스트는
  `backtest-runner.ts:381` 로 `prepare` 를 타므로 같은 가드를 지난다. 전체 스위트 초록.
- **새 테스트가 공허한가**: 9종 중 7종이 red. 생존 2종은 F-1·F-5 로 접수했다.

---

## 라운드 1 의 F-1 · F-2 판정

| v1 finding | 판정 | 근거 |
| --- | --- | --- |
| **F-1** (정상 분할 50~75% 거절) | **부분적으로 닫힘** | 여유 현금이 있는 계정에서 0% (`p2` E: 헤드룸 100 minor 이상 → 0/200). 헤드룸이 `수량 × (분자−1)/분자` minor 미만이면 **50% 그대로** — F-4 로 재접수. |
| **F-2** (market + limitPrice 회귀) | **닫힘** | `service.ts:453` 이 `orderType !== "limit" && limitPrice !== undefined` 를 거부. v1 프로브의 payload 는 이제 `prepare` 에서 `invalid_payload`. 뮤테이션 M7 로 커버 확인(제거 시 `t10-blind-of6` red). |
| F-3 (양성 대조군 부재) | **닫힘** | `t10-blind-of6.test.ts` 에 현금 예약 양성 대조군이 다수 존재(지정가·시장가·부분체결·타종목). |

---

## 검증 근거 (이 리뷰 자체)

- `npx vitest run` → `Test Files 91 passed | 11 skipped (102)`, `Tests 963 passed | 56 skipped (1019)`
  (md5 `9072c92a…` / `f9454ab3…` 기준으로 재실행)
- `npx tsc --noEmit -p tsconfig.json` → 출력 없음(통과)
- 프로브 6종 전부 위 md5 기준으로 재실행해 본문 출력 확보. F-3 은 HEAD 복사본에서도 실행해 대조.
- 뮤테이션 9종: 격리 복사본에서 실행, 원 저장소 무변경
- `git status --porcelain` — 리뷰어가 만진 추적 파일 0개
