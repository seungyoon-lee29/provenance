# Stage 2-c — 원장 강화 (T8 착수 전 필수)

상태: 미착수 (2026-07-24 사용자 결정으로 스코프 확정. 다음 세션은 여기부터)

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

## 수용 오라클

- 전 통화에서 fold 산술에 비정수 float 연산 0 (grep + property)
- property 스위트가 memory·PG 양 러너에서 green
- 0006 up/down 왕복이 verify-migrations 통과, backup-drill ALL_TABLES 정합 유지
- 4번 판정 결과가 이 문서에 기록됨 (버그면 수정 커밋, 아니면 반증 근거)
