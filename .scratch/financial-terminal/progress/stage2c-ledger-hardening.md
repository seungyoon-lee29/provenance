# Stage 2-c — 원장 강화 (T8 착수 전 필수)

상태: **완료** (2026-07-24, 커밋 5387c5e — item 1~4 + tier top 게이트 4종). Owner: main(Opus 4.8). Claimed: 2026-07-24.
(상태줄 정합 갱신 2026-07-24 후속 세션 — 커밋 5387c5e가 map.md 트랙 상태 한 줄 갱신을 누락해 함께 보정)

**설계 결정 (item 1, contained)**: `foldAccountState` 내부 누적을 정수 minor-unit으로 전환
(float drift·EPSILON 제거)하되, 공개 타입 `PaperCashState`/`costBasis` 는 경계에서 정확한
`fromMinorUnits`(정수/scale)로 major-unit 유지 — 메모 "경계 변환만 정리" 정합, simulator/service
소비자 불변. property 오라클도 동일 정수 누적으로 바꿔 `toBeCloseTo` → `toBe` 정확 비교.
나눗셈(평균단가 relief·split limit)은 `Math.round(int*int/int)` 결정론 반올림(오라클과 동일).

## Blast radius / 검증 tier 선언 (AGENTS.md 하한 — 착수 전 필수 절)

- **Tier: 최상위** — money 산술 + migration 경로 (collaboration.md tier 표의 자동 승격 대상)
- **요구 게이트**: blind test-authorship(별도 에이전트가 구현 미열람으로 반증 테스트 작성) +
  codex(다른 계열) 반박 패널 + Standards 축 code-review 1패스 + mutation 실증
- **커밋 트레일러**: `Tier: top (adversarial=이 문서, blind=이 문서, standards=이 문서)` —
  tier-gate(commit-msg 훅)가 강제한다. **이 티켓이 2026-07-24 도입된 tier 체계의 첫 실전이다.**
- **Contain**: 프로덕션 소비자 0 (paper-trading 은 아직 composition 미배선) — blast radius 낮음.
  그래도 tier 는 코드 경로 기준으로 최상위 유지 (T8 부터 이 원장이 돈의 유일 경계가 된다)

## 스코프 (2026-07-24 codex 적대 2차 + 메인 판정 결과 — pivot 메모 §6 검증기록 ② 참조)

1. **PaperMoney minor-unit 정수 전환** — `amount` 를 최소단위 정수(KRW 원 / USD 센트)로.
   시뮬레이터는 이미 BigInt tick 정수 — 구멍은 원장 fold 와 JSONB 왕복의 float 산술이다.
   `currencyMinorUnitScale` 이 이미 있으니 경계 변환만 정리하면 된다. mockstock `fillOrder` 의
   toCents/fromCents 패턴이 참조 설계.
2. **money-conservation property 를 PG 러너로도 실행** — 현재 memory store 전용.
   기존 계약 테스트의 `PG_INTEGRATION` 게이트 패턴 재사용 (composition 배선은 불필요 — 그건 T8).
3. **0006 마이그레이션 (방어층)** — entry JSONB 의 account/revision ↔ 관계형 컬럼 일치 CHECK(또는 생성 컬럼),
   `paper_command_receipt`/`paper_system_key` → entry FK. 현 코드 경로로는 불일치 생성 불가하나
   외부 쓰기·restore 경로에 무방비 (codex HIGH 2건 → 메인이 방어층 과제로 강등 판정).
4. **동시 동일-키 재시도 실 PG 재현 테스트** — codex 미판정 건: loser 가 원 outcome 대신
   conflict 를 받는지. store 레벨은 receipt-first ON CONFLICT 로 duplicate 처리로 보이나
   journal 캐시 레이어 race 는 실측으로 판정할 것.

## 진행

- **item 1 완료** (memory 경로 검증): fold·validation·simulator·service·property 오라클을 정수 minor-unit으로.
  money EPSILON 제거(journal fill-cash 340, simulator buy 243, service submit-guard 290). split price 조정은
  minor 반올림(센트 정확). property `toBeCloseTo`→`toBe`(정확 보존). 남은 EPSILON은 shares(simulator 252·
  journal 352)·volume(131)·tick 정렬(service 108)로 fold 밖. 게이트: tsc 0 · 전체 비-pg 569 통과 · 돈경로 grep에서
  fold 누적에 major-amount 접근 0. **PG 검증은 item 2와 함께.**
- **item 3 완료** — `0006_paper_ledger_defense`: ① entry JSONB↔컬럼(account/revision/entryReference) CHECK
  ② receipt/system_key → entry **DEFERRABLE INITIALLY DEFERRED** FK(receipt-first 순서 보존, store가 새
  `entry_reference` 컬럼 채움). migration-smoke(up/down/재적용) green. backup-drill은 paper entry/receipt/key에
  INSERT 안 하므로(fence만) 무관, ALL_TABLES CASCADE 정합 유지 — drill 1·2 green.
- **item 2 완료** — money-conservation property를 store 팩토리로 파라미터화해 memory(100 runs)·PG(15 runs, TRUNCATE)
  양 러너. `test:persistence-pg`에 property 추가(persistence-integration 레인이 PG_INTEGRATION=1로 실행). PG 8 tests green.
- **item 4 완료 — 판정 결과: 버그 확정 → 수정.** 동시 동일-키 재시도(두 저널이 한 durable store 공유)에서 **loser가
  `conflict`를 받았다**(§8 위반: 같은 키+같은 payload는 원 receipt=applied여야 함). 근인: `journal.ts` appendCommand가
  store `duplicate`를 **무조건 conflict로 매핑**(cache-known 경로는 payload 비교 후 원 outcome을 돌려주는데 store-duplicate
  경로는 안 함). **수정**: duplicate 시 `#staleCache`+`#ensureFresh`로 rehydrate 후 durable receipt 조회 —
  payload 일치면 원 outcome, 불일치면 conflict(cache-known 경로와 동형). 계약 테스트 추가(memory·pg 공통) +
  PG 20-iter 동시성 스트레스. 기존 reconcile 테스트는 cache가 **이미** hydrate한 경우만 커버해 이 갭을 놓쳤다.

## 게이트 (tier top — 첫 실전)

- **blind test-authorship** (별도 sonnet 에이전트, 구현 미열람): SPEC 4항(minor 왕복·정확 cash 보존·
  §8 원 receipt·split 무이동)에 대해 `tests/property/stage2c-blind.property.test.ts` 6테스트 독립 작성 →
  **6/6 pass, 약화 없음**. §8은 제3의 fresh 저널로 reserved-once 독립 확인. **무결성 노트**: 에이전트가
  자진 보고 — 중간에 `grep "^export" journal.ts`로 **타입명**이 노출됨(함수 본문/로직 0, prompt가 이미 준 것과 일치).
  독립성 유지되나 완전 blind는 아니었음을 기록. 테스트 파일은 표준 회귀로 보존.
- **codex 적대 반박** (다른 계열): **확정 5건(3 HIGH + 1 HIGH-migration + 1 MEDIUM)**. 판정·조치:
  | 심각도 | 지적 | 조치 |
  |---|---|---|
  | HIGH | sub-tick per-unit 반올림이 cash 생성/소멸 | `minorUnitsOf(count*price)` 집계 반올림. sub-cent 배당 회귀 테스트($0.005×3=2¢) |
  | HIGH | stale expectedRevision 재시도가 durable reconcile 전에 rejected | revision 실패 시 rehydrate 후 durable receipt 조회 우선. 계약 테스트 |
  | HIGH | split이 live 한계가를 sub-cent로 → 예약 해제·체결불가 | validateSystemBody가 split 후 한계가 <1 minor면 fail-closed 거절. 회귀 테스트 |
  | HIGH | 0006 CHECK가 JSON 필드 누락 시 NULL로 통과 | `entry ? 'key'` 존재 강제를 CHECK 앞에 추가 |
  | MED | safe-integer(2^53) 초과 | 문서화(ponytail): 도메인 상 도달 불가($90조), 필요 시 bigint |
  반증 실패(성립): claim 4 — 생존 소비자 전부 minor 내부 사용, presentation만 major 변환.
- **Standards 축 리뷰**: lint 0 error(기존 경고 1 무관), 명명 일관(`minorUnitsOf`/`toMinorUnits`/`fromMinorUnits`/
  `PaperMinorMoney`), 모든 비자명 변경에 근거 주석.
- **mutation 실증 2건**: ① §8 수정을 옛 버그(duplicate→conflict)로 되돌림 → 계약 테스트 실패(복원 후 통과).
  ② fold seed를 major(`seed.amount`)로 되돌림 → property `toBe` 실패(1,000,000≠100,000,000, 복원 후 통과).

## 수용 오라클 (결과)

- ✅ fold 누적(cash·cost basis·reserved)에 비정수 float 0 — 정수 minor. 나눗셈은 relief 반올림(`Math.round`,
  full 청산 시 정확 0)·split 비율(가드로 sub-minor 차단)뿐. property `toBe` 정확 비교.
- ✅ property 스위트가 memory(100 runs)·PG(15 runs) 양 러너 green.
- ✅ 0006 up/down 왕복 verify-migrations green, backup-drill drill 1·2 green(ALL_TABLES 정합).
- ✅ item 4 판정 결과 기록됨(버그 확정 → 수정 커밋).

## 잔여 위험

- **sub-cent 가격/배당은 cents 원장에서 표현 불가** — split이 한계가를 sub-minor로 만들면 fail-closed 거절.
  sub-cent 배당은 집계 반올림으로 최근접 cent. 정밀이 필요해지면 통화별 스케일 확대(현재 KRW=1·USD=100).
- **safe-integer(2^53) 상한** — minor는 JS `number`. 도메인 상 도달 불가, 필요 시 bigint([[stage2c 게이트]] codex MED).
- 배선 미완(T2-b 잔여 유지): `PgPaperJournalStore`·`PaperTradingErasure` 실조립은 T8+ 소비자 몫.
