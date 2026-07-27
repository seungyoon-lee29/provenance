# 적대 리뷰 v1 — OF-6 수정 (`applySplitToOrder` + `reservation_not_conserved`)

- **대상**: `git diff` 현재 워킹트리 — `src/modules/paper-trading/internal/journal.ts`,
  `tests/f8-journal-boundary.test.ts`, `tests/t10-round2-money-ceiling.test.ts`
- **일시**: 2026-07-27
- **판정 기준**: `file:line` + 재현 명령/실패 테스트가 있는 것만 **접수**. 나머지는 §의견.
- **리뷰어가 만진 것**: 없음. 추적 파일 무변경(`git diff --stat` 로 확인, 이 문서만 신규).
  프로브는 전부 스크래치패드에서 `npx tsx` 로 실행.

---

## 요약

원래 공격(2^53 예약 폭주)은 **닫혔다**. 보존 검사는 정확한 등식이라 몇 번을 쪼개도
예약 총액이 자라지 않는다. 새 가드 4개는 전부 **비어 있지 않다**(뮤테이션 5종 전부 red).

그런데 이 수정은 **두 개의 새 결함을 만들었다**, 둘 다 실행으로 재현했다.

1. **F-1 (High)** — 정상 분할의 **50~75%가 이제 거절된다.** 액면가 센트가 홀수인
   살아있는 지정가 매수 하나만 있으면 2:1 분할이 통째로 거절되고, **포지션도 안 쪼개진다.**
   원장이 현실과 영구히 어긋난다. 거짓 거절도 결함이라는 것이 이 리뷰의 전제다.
2. **F-2 (High, 회귀)** — (4)번 "매수의 지정가 = 예약 단가"라는 전제가 **거짓이다.**
   `orderType: "market"` + `limitPrice` 조합을 `validPayload` 가 막지 않는다. 그 주문은
   예약 단가와 지정가가 갈라지고, 보존은 성립하는데 지정가는 0으로 양자화된다.
   **수정 전 코드는 이걸 거절했다. 수정 후에는 통과한다.** 좁힌 것이 정확히 구멍이었다.
3. **F-3 (Medium)** — F-1 이 초록 스위트(958 pass)를 뚫고 나온 이유: **현금 예약 주문이
   분할을 살아서 통과한다는 양성 대조군이 한 개도 없다.** t10 의 양성 대조군은 수량 예약
   (`openSellOrder`)이라 새로 넣은 분기를 안 지난다.

(3)번 QUANTITY 제외와 (6)번 비-가드는 깨지 못했다 — §깨지지 않은 것 참조.

---

## 접수된 finding

### F-1 (High) — 평범한 분할이 거절된다. 포지션까지 같이 안 쪼개진다

- **위치**: `src/modules/paper-trading/internal/journal.ts:403-412` (보존 검사),
  `:276` (`Math.round` 양자화)
- **기전**: 예약 단가를 **분할 후 단가 × 분할 후 잔량**으로 재유도한다. 단가가 minor
  단위로 반올림되므로, 단가의 센트 수가 분자로 나누어떨어지지 않으면 곱이 원래 값과
  달라진다. 100주 @ $101.03 의 2:1 → 단가 `round(10103/2)=5052`, 잔량 200 →
  `1010400 ≠ 1010300` → `reservation_not_conserved`. 분할 엔트리 전체가 거절되므로
  같은 엔트리가 하던 **포지션 수량 배증도 일어나지 않는다**. 액션은 `PaperLifecycleIngestion.applySplit`
  (`lifecycle.ts:37`) 로 들어오는 실세계 사건이고, 거절은 기록되지 않으므로 재전달해도
  같은 이유로 또 거절된다 → **영구 불일치.**
- **재현** (`npx tsx <path>/probe1.ts`, 저장소 루트에서):

  ```ts
  // 하네스는 tests/f8-journal-boundary.test.ts 의 harness/submit/shellOf 와 동일
  const { service } = harness();
  const { account } = await submit(service, limitBuy(100, 101.03), "p1");
  // reserved before: 10103  (= $10,103.00)
  const outcome = await split(service, account, "p1-split", 2, 1);
  // → {"status":"refused","reason":"reservation_not_conserved"}
  // reserved after: 10103, order qty after: 100   ← 분할이 통째로 안 일어났다
  ```

- **실측 거절률** (센트가 1~1000, 수량 100, 매번 새 계정):

  | 분할 | 거절률 |
  | --- | --- |
  | 2:1 | **500/1000 (50.0%)** |
  | 3:1 | **667/1000 (66.7%)** |
  | 4:1 | **750/1000 (75.0%)** |
  | 3:2 | **667/1000 (66.7%)** |
  | 1:2 (역분할) | 0/1000 |
  | 1:10 (역분할) | 0/1000 |

  역분할이 0%인 것이 기전을 확증한다 — 역분할은 단가를 **곱하므로** 반올림 손실이 없다.

- **수정 전 대조** (`git show HEAD:...journal.ts` 를 복사본에 넣고 같은 프로브):
  `{"status":"applied"} / reserved 10103 → 10104` — 즉 예약이 **100 minor(=$1.00)**
  조용히 부풀었다. 그것이 OF-6 이다. 지금 수정은 **$1 의 조용한 팽창을 분할 전면 거부로
  바꿨다.** fail-closed 이긴 하나, 원장이 현실을 표현하지 못하게 되는 것은 별개의 결함이고,
  이 저장소 자신의 기준이기도 하다 — `contracts.ts:522` : *"a guard should not buy
  soundness with false refusals."*
- **심각도 근거**: 돈을 잃지는 않는다(High, not Blocker). 그러나 OF-6 의 목표는 "예약이
  무한 팽창하지 않는다"였지 "분할을 못 한다"가 아니었고, 지금 상태로는 능동적으로 운용되는
  계정의 절반 이상이 실세계 분할을 반영하지 못한다.
- **방향 (참고, 근거는 위 실측)**: 예약을 **분할 후 단가에서 재유도**하는 대신 gross
  minor 를 보존량으로 들고 다니면(예약을 `{kind:"cash", grossMinor}` 로) 반올림이 개입할
  자리가 없어진다. 지금 형태는 `unitPrice` 가 정본이라 양자화가 구조적으로 불가피하다.

---

### F-2 (High, 회귀) — (4)번 좁힘의 전제가 거짓이다: 매수의 지정가 ≠ 예약 단가

- **위치**: `src/modules/paper-trading/internal/journal.ts:392-396`
  (`order.payload.side === "sell"` 로 좁힌 sub-minor veto).
  전제가 깨지는 지점: `src/modules/paper-trading/internal/service.ts:411`
  (`if (payload.orderType === "limit") return payload.limitPrice;` — market 이면 관측가 기반)
  + `src/modules/paper-trading/internal/service.ts:450-461` (`validPayload` 가
  `orderType: "market"` + `limitPrice` 동시 존재를 **거절하지 않는다**)
  + `src/modules/paper-trading/internal/journal.ts:457-464` (체결 검사는 `orderType` 과
  무관하게 `limitPrice` 가 있으면 지정가로 묶는다)
- **주장 반박**: 주석은 *"A BUY order's limit price is its reservation unit price, so the
  conservation check below already covers that side"* 라고 쓴다. 이는 `orderType==="limit"`
  인 매수에만 참이다. `orderType:"market"` 인데 `limitPrice` 를 든 payload 는 공개
  API(`prepare`→`change`)를 그대로 통과하고, 그 주문의 예약 단가는 **관측가 + 슬리피지**,
  지정가는 **payload 의 값** — 서로 다른 수다. 분할은 둘을 각각 반올림하므로 하나는
  보존되고 다른 하나는 0 이 될 수 있다.
- **재현** (`npx tsx <path>/probe3.ts`, 저장소 루트에서). 종가 $1.01, `maxSlippageBps: 25`
  → 예약 단가 102 minor(3 으로 나누어떨어짐), 지정가 1 minor, 수량 1, 3:1 분할:

  ```ts
  const payload = { ...limitBuy(1, 0.01), orderType: "market" }; // market + limitPrice
  // submit OK. reserved before: 1.02
  await journal.appendSystem(WORKSPACE, account, "split",
    { kind: "corporate_action_applied", action, instrument: AAPL,
      adjustment: { kind: "split", numerator: 3, denominator: 1 } });
  ```

  **현재 코드 출력:**

  ```
  3:1 split outcome: {"status":"applied","revision":3}
  reserved after: 1.02                                   ← 보존은 성립한다 (102 = 3 × 34)
  order after: {"qty":3,"limitPrice":{"amount":0,"currency":"USD"},"execution":"open"}
  cheapest possible fill (1 minor unit): {"status":"refused","reason":"order_not_fillable"}
  ```

  **수정 전(HEAD) 같은 프로브 출력:**

  ```
  3:1 split outcome: {"status":"refused","reason":"fractional_result"}
  order after: {"qty":1,"limitPrice":{"amount":0.01,...},"execution":"open"}
  cheapest possible fill (1 minor unit): {"status":"applied","revision":3}
  ```

  재현 절차: `git ls-files -z | xargs -0 tar cf - | (cd <scratch>/mut && tar xf -)`,
  `git show HEAD:src/modules/paper-trading/internal/journal.ts > <scratch>/mut/src/.../journal.ts`,
  경로 치환 후 같은 스크립트 실행.

- **결과 상태**: 열린 매수 주문이 지정가 $0.00 을 들고 살아 있다. 양수 가격의 어떤 체결도
  `order_not_fillable` 로 거절되므로 **영원히 안 채워지고**, 그동안 $1.02 의 현금 예약을
  계속 붙들고 있다. 취소/만료로만 풀린다. 이것이 좁히기 전 veto 가 막던 바로 그 피해다
  (원 주석: *"leave an order no positive fill can ever satisfy"*).
- **심각도 근거**: 현금을 창조하지는 않는다. 그러나 **수정 전에는 거절되던 상태가 수정 후
  통과한다** — 순수 회귀이며, 그 회귀를 만든 것이 이 변경에서 가장 논쟁적인 결정(4)이다.
- **최소 수정 후보 두 개** (택일):
  - `validPayload` 에서 `orderType === "market" && limitPrice !== undefined` 를 거절
    (전제를 참으로 만든다 — 더 좁고, 다른 경로도 같이 닫힌다), 또는
  - veto 를 `side === "sell"` 이 아니라 **`reservation.kind !== "cash" || limitPrice !==
    reservation.unitPrice`** 로 되돌린다(전제가 성립하는 경우만 면제).

---

### F-3 (Medium) — 새 분기에 양성 대조군이 없다. 그래서 F-1 이 초록을 뚫고 나왔다

- **위치**: `tests/t10-round2-money-ceiling.test.ts` 의 신규 블록 마지막 케이스
  (`"양성 대조군: 평범한 수량의 3:1 은 통과한다"`) — 쓰는 주문이
  `openSellOrder` = `tests/t10-round2-money-ceiling.test.ts:63-81`,
  `reservation: { kind: "quantity" }` (`:79`).
  `tests/f8-journal-boundary.test.ts` 의 OF-6 블록 3 케이스는 **전부 거절 단언**이다.
- **주장**: 이 변경이 추가한 분기(`journal.ts:403-412`, cash 예약 보존)를 **통과**하는
  테스트가 하나도 없다. 그래서 "정상 분할의 50%가 죽는다"가 스위트 안에서 보이지 않는다.
- **재현**:
  - `npx vitest run` → `Test Files 91 passed | 11 skipped`, `Tests 958 passed` (전부 초록)
  - 그 상태에서 `npx tsx <path>/probe1.ts` → `1000/2000` 거절 (F-1)
  - 초록 + 50% 오작동이 공존한다는 것이 곧 커버리지 공백의 증거다.
- **뮤테이션 결과 (참고 — 새 가드 자체는 비어 있지 않다, 5/5 red)**:

  | 뮤테이션 | 결과 |
  | --- | --- |
  | M1 보존 검사 제거 (`:411`) | f8 2건 red |
  | M2 포지션 `isExactMinor` 제거 (`:371`) | t10 1건 red |
  | M3 주문 `isExactMinor` 제거 (`:384-386`) | t10 1건 red |
  | M4 sell sub-minor veto 제거 (`:392-396`) | f8 1건 red |
  | M5 veto 를 양쪽으로 되돌림 (수정 전 의미) | f8 1건 red |

  단, **M5 가 red 인 이유는 "거절 여부"가 아니라 거절 *사유 문자열*이 바뀌기 때문이다**
  (`reservation_not_conserved` vs `fractional_result`). 즉 (4)번 좁힘을 지키는 것은
  사유 문자열 단언 하나뿐이고, 그 단언은 F-2 의 회귀를 잡지 못한다.

---

## 의견 (근거 없음 — 수정 근거로 쓰지 말 것)

- **O-1**: 보존 검사를 주문별로 둔 이유("통화 단위 합계면 한 주문의 팽창이 다른 주문의
  수축 뒤에 숨는다")는 설득력 있으나, 그 은닉을 실제로 만드는 상태를 나는 구성하지 않았다.
  주장 자체는 옳아 보이지만 **미검증**.
- **O-2**: `numerator`/`denominator` 에 상한이 없다. 극단값은 안전정수 가드가 잡는 것을
  코드로 읽었으나, 포지션·주문이 **둘 다 없는** 계정에 `numerator: 1e308` 분할이 기록될 수
  있다는 것은 재현하지 않았다. 무해해 보이지만 **미검증**.
- **O-3**: `applySplitToOrder` 의 반환 타입이 `PaperOrderState` 의 부분집합을 손으로
  나열한 구조체라, 나중에 `payload` 에 분할이 건드려야 할 필드가 생기면 조용히 빠진다.
  현재 결함은 아니고 재현 불가 — 설계 의견.

---

## 내가 시도했지만 깨지지 않은 것

- **원 OF-6 공격(2^53 예약 폭주)**: 보존이 **정확한 등식**이라 분할을 몇 번 반복해도
  `reserved` 가 자라지 않는다. 1¢ 지정가 매수 2:1 은 f8 신규 테스트대로 거절된다. **닫혔다.**
- **(3) QUANTITY 예약 제외로 주식을 조작할 수 있는가 — 못 했다.**
  매도 주문의 예약은 잔량 그 자체이고, 포지션과 주문 수량이 **같은 비율 k 로** 스케일되며
  둘 다 정수·안전정수임이 강제된다(`:367,371,381,384`). 따라서 `position ≥ reserved` 가
  스케일 후에도 보존된다. 반올림이 끼어들 자리가 없다(수량에는 `Math.round` 가 없다).
  역분할(1:2, 1:10)로 잔여를 만들어내려 했으나 `fractional_result` 가 먼저 잡는다.
  매도 쪽 지정가 0 양자화는 남겨둔 veto 가 잡는다(M4 로 확인).
- **(6) `afterMinor` 안전정수 비-가드가 도달 가능한가 — append 경로로는 도달 못 했다.**
  `afterMinor`가 안전 범위 밖이면서 통과하려면 `beforeMinor` 가 그것과 **같으면서** 이미
  범위 밖이어야 한다. 그런데 제출 시 `requiredMinor ≤ availableMinor = balance − reserved`
  (`service.ts:376-382`)이고 `balance` 는 genesis 의 `isRepresentableSeedCash` 와
  fill/dividend 의 `isExactMinor` 로 2^53 아래에 묶인다. 그러므로 `beforeMinor ≤ 2^53`.
  주석의 논증이 성립한다 — 다만 `validateSystemBody` 를 **직접** 합성 state 로 부르면
  (t10 이 하는 방식) 그 상태를 만들 수 있다. 그건 이미 깨진 원장이고, 부작용 없는 순수
  판정이라 새 피해가 없다.
- **fold ↔ validator 발산 — 못 찾았다.**
  주문 선택 술어가 실제로 같다: fold `reserving()` (`:901-906`) = execution ∈
  {open, partially_filled} ∧ cancellation ∈ {none, requested, rejected};
  validator (`:375,379`) = 같은 execution 집합 ∧ cancellation ≠ confirmed. 취소 축의
  값 집합이 넷이므로 두 술어는 동치다. 예약 총액 계산식도 양쪽 다
  `grossMinorOf(quantity − filledQuantity, reservation.unitPrice)` 로 동일
  (`:404-405` vs `:1073-1076`). `limitPrice` 키의 유무도 보존된다(`:1049`).
  **`applySplitToOrder` 로 하나의 정의를 만든 것은 실제로 효과가 있다** — F-2 는 두 정의의
  발산이 아니라 *"지정가와 예약 단가가 같다"는 별개의 거짓 전제*에서 나온다.
- **부분 체결·취소 요청/거부 상태**: `filledQuantity` 도 같은 함수로 스케일되고 양쪽이
  같은 잔량을 쓴다. `cancellation: "requested"|"rejected"` 는 양쪽 다 살아있는 주문으로
  취급한다. 발산 없음.
- **다중 통화**: 예약 통화는 `reservation.unitPrice.currency` 로 분할이 안 건드린다.
  통화별로 독립. 깨지지 않았다.
- **새 테스트의 공허성**: 없다. 가드 5종 뮤테이션 전부 red (위 표). 다만 F-3 의 공백은
  별개 — 가드가 *과잉* 발화하는 것을 잡는 테스트가 없다.

---

## 검증 근거 (이 리뷰 자체)

- `npx vitest run` → `Test Files 91 passed | 11 skipped (102)`, `Tests 958 passed | 56 skipped`
- 뮤테이션 5종: 격리 복사본(`git ls-files | tar`)에서 실행, 원 저장소 무변경
- 프로브 4종 전부 이 세션에서 재실행해 위 출력 확보 (F-1·F-2 는 수정 전/후 양쪽 실행)
- `git diff --stat` — 리뷰어가 만진 추적 파일 0개
