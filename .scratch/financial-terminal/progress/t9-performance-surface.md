# T9 — 성과 리포트 표면: gross vs net + tax drag (착수 2026-07-25)

> Stage형 예외(AGENTS.md 2026-07-24 명문화): 번호 티켓 대신 이 문서로 갈음. 정식 티켓(42~)은 Stage 3 뒤.

## Blast radius / 검증 tier 선언 (착수 전 필수 절)

**경로**: `src/modules/paper-trading/backtest/`(performance-report + runner) — guarded 경로.
**성격**: T8 S4a와 동형의 **read-only 집계** — fold·money mutation 무접촉. 원장이 이미 아는
매도세(`fills[].costs.sellTransactionTaxMinor`, S3에서 저장·검증됨)를 합산해 공개할 뿐이다.
**tier**: **top** — 수치가 사용자 투자 판단 입력(tax drag 과소/과대 = 그럴듯한 거짓 비용 공시).
S4a 선례(read-only여도 코드 경로 기준 top 유지). resolve 전 4축(blind·codex·Standards·mutation).

## 범위 확정 (실측 근거)

**T9 원 정의 소멸 확인**: pivot §"이후 — 엔진"의 T9("F7 TWR/XIRR 재사용 + MDD·승률 + 체결
신뢰도 집계")는 **T8 S4a(TWR·XIRR·MDD·체결신뢰도)+S4b(승률)가 전부 흡수**했다. pivot 규칙에
따라 pivot 메모에 정정 기록(전제: F7 재사용 → 실제: 격리 불변식 때문에 닫힌형 러너 내장).

**남은 실체** (설계 문서 `t8-transaction-cost-model-v1.md` §2 표 "T9 리포트" 행):
**gross vs net 수익률 (tax drag 한 줄) — 차별점 표면.**

- `BacktestPerformance.tax`: `taxPaid`(런 전체 매도세 합, major) +
  `grossTimeWeightedReturn`(세금을 종결 가치에 되더한 TWR — **1차 근사: 절약분 재투자 없음
  가정, 타입 doc에 명시 고지**) + `taxDrag`(gross − net, coverage-typed).
- 러너: `finalState.orders`의 fill costs 합산(read-only) → 리포트 전달. fold 무변경.
- 미과세 런(costModel "none"): taxPaid 0·drag covered 0 — 사실이지 조작 아님.
- **비범위**: gross XIRR(TWR 쌍으로 "gross vs net 한 줄"은 충족, YAGNI), 수수료(CostPolicy
  확장점은 설계 문서 §3 그대로 v2), CLI/MCP 표면 노출(T10).

## 진행

- [x] 구현 + demo self-check + 테스트 (2026-07-25)
- [x] 4축 게이트 (아래 판정)
- [x] pivot 메모 정정 기록 (T9 흡수 + F7 재사용 전제 — pivot §"이후—엔진" T9 항 ←정정)
- [x] 커밋 (Tier: top 트레일러)

## 게이트 종합 판정 (tier top, 2026-07-25)

4축 완주. check green · build green.

- **Standards ✅** (sonnet): 하드 0, 판단 3. 수용 2 — ① 러너가 `finalState.orders` 재순회(중복
  순회) → `presented.orders` 재사용 ② 파일 헤더 doc에 T9 미반영 → 갱신. 기각 1 —
  `taxPaidValue`→`taxPaid` 입력 개명은 cosmetic + blind 축이 저작 중인 공표 계약과 충돌(기록만).
- **blind ✅** (sonnet, 구현 미열람): `tests/t9-tax-blind.test.ts` **12/12, 엔진 결함 0**.
  유일 불일치는 blind 자신의 유도 오류(20bp를 2%로 오산 — floor(119,930×20/10000)=239 ≠ 2,398)로,
  실패 단언을 손으로 재유도해 자가 교정(프로세스가 의도대로 작동: 엔진이 오산을 노출). 세금-플립·
  ETF 면제·"taxed gross == untaxed net 비트일치" 독립 유도 전건 일치. 이후 계약 진화(coverage
  유니언)·equity number[] 타입은 인터페이스 적응만(단언 강화 방향, 무약화).
- **codex ✅** (다른 계열): 판정 **REJECT — HIGH 1·MED 1**. 프로브(probe-t9.mts·probe-t9-churn.mts) 재현 후 수정:
  | 심각도 | 지적 | 재현 | 조치 |
  |---|---|---|---|
  | HIGH | 개별 검증된 세금들의 **합**이 2^53 초과 시 float 누산기 드리프트 → covered 거짓 총액 | **클래스 재현**: 경계가 1e19 시드 수용(isInteger는 통과·isSafeInteger 불통) + 합산 드리프트 1원 실증. codex의 E2E 인스턴스는 체결 분할이 달라 우연히 표현가능 합에 착지 — 대신 **safe 시드 하 18사이클 복리 churn**으로 결정론 드리프트(exact …959 vs float …960) 시나리오를 직접 공학해 standing 회귀화 | ① 시드 경계 `isSafeInteger` 강제(원장의 문서화된 2^53 천장을 경계에서 집행 — 1e19 → `invalid_seed_cash`) ② 합산 가드: 비안전 합 → NaN poisoning → `invalid_total` |
  | MED | NaN/Infinity `taxPaid`가 직렬화 필드에 잔존 → JSON `taxPaid:null`(선언 타입 위반) | 재현(JSON 출력 확인) | `TaxDisclosure`를 **전체 coverage 유니언**으로: 총액 불신 시 블록 전체 `unavailable("invalid_total")` — 직렬화 필드에 비유한 수 잔존 불가. zero-window는 covered 블록 내 개별 return만 unavailable(taxPaid는 창 무관 원장 사실로 유지) |
- **mutation ✅** 4건: ① 시드 safe 가드 되돌림 → 1e19 회귀 사망(1) ② 합산 가드 제거 → churn
  드리프트 회귀 사망(1) ③ invalid_total 거부 제거 → 6 사망 ④ gross 되더하기 제거 → 4 사망.
  각 복원 후 45 전건 통과.
- 사고 기록: mutation 스크립트의 잘못된 `git checkout`이 러너의 미커밋 T9 변경을 일시 유실 —
  전 변경이 파악된 상태라 즉시 재적용(tsc+45 green 재확인). 이후 mutation은 perl 왕복만 사용.
- 회귀: blind 12 파일 + 슬라이스 5(경계 3·1e19·churn) + 세금 E2E 강화. **T9 게이트 통과.**
