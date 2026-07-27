# Stage 2 — 게이트를 "실행으로" 증명하기 + 음성 대조군 + 정적 층

착수 2026-07-27 (stage-1 직후). 계기: arch-2 리뷰가 지목한 **하네스 레벨** 두 건과 정적 층.

stage-1 은 B 그룹 결함 4건을 개별로 고쳤다. 이 단계는 그 4건이 **같은 결함의 변주**라는 진단에
대응한다: 게이트의 통과 조건이 검사 대상과 같은 아티팩트 위에 정의돼 있어서 "통과"와
"검사를 못 함"이 구분되지 않는다. 그 결함은 구조적으로 무증상이다 — 초록이 정상 상태이므로
작동하는 게이트와 영원히 통과하는 게이트는 **출력이 완전히 동일하다.**

## Blast radius / 검증 tier 선언 (collaboration.md 표 기준, 착수 전 필수)

| 축 | 판정 |
| --- | --- |
| 건드리는 경로 | `src/modules/paper-trading/internal/{journal,blotter}.ts`, `backtest/backtest-runner.ts` — tier-gate guarded. 그 외 게이트 스크립트·CI·설정·정적 층 |
| **검증 tier** | **최상위 (자동 승격, 판단 없음)** — guarded 경로 diff |
| 추론 강도 | High (게이트 설계) / XHigh (guarded 경로 편집) |
| 되돌릴 수 없음 | **낮다** — guarded 경로 변경은 전부 타입 수준이거나 키 존재 보존용 조건부 spread. 런타임 값 변경 0, 마이그레이션 0, 저장 포맷 변경 0 |
| blast radius | CI 레인 2개 추가(음성 대조군, nightly mutation). `npm run check` 는 기존과 동일하되 린트 규칙이 늘어 **새 커밋이 red 가 될 수 있다** — 의도된 것 |
| Contain | 정적 층은 규칙별로 스코프를 나눠 집행 범위를 좁힘. 부채는 설정 주석에 실측치와 함께 명시 |

### prior-decisions 조회 결과

조회 범위: `.scratch/**/progress/*.md`, `docs/adr/`, `gate-ledger.txt` 헤더, `stryker.config.mjs` 주석.

| 항목 | 걸리는 선행 결정 | 판단 |
| --- | --- | --- |
| Stryker 배선 | `gate-ledger.txt:85` — `test:mutation unwired:… 아키텍처 리뷰 별건 후보` | **그 별건을 지금 처리한 것.** 거스름 없음 |
| Stryker 범위 | `stryker.config.mjs` 주석 — "Widen `mutate` to identity/vault/portfolio/accounting as budget allows" | 원 저자가 예고한 확장을 실행. 거스름 없음 |
| gate-ledger 판정 방식 | stage-1 이 substring → 호출 형태로 강화 | **강화지 번복이 아님.** 정적 판정의 한계를 인정하고 실행 층을 옆에 붙였다 |
| `no-unnecessary-condition` | `journal.ts:556` 주석 "Runtime backstop for untyped callers" | **거스르지 않는다.** 규칙을 끄고 부채로 남김 — 아래 참조 |

---

## 1) "배선"을 grep 이 아니라 실행으로 증명한다

리뷰의 제안은 "게이트가 돌 때 토큰을 찍고 원장 검사가 CI 로그에서 그 토큰을 찾는다" 였다.
**더 강한 것으로 대체했다**: 토큰은 게이트가 *돌았다*만 증명하지만, 알려진 나쁜 입력에 red 가
나온 것은 게이트가 *돌았고 판별력이 있다*를 증명한다. 즉 음성 대조군이 배선의 실행 증명을
포함한다. 토큰 수집을 위한 잡 간 아티팩트 배관도 필요 없다.

`scripts/gates/negative-control.sh` (CI `PR-fast` 에 배선). 규율 두 가지:

- **red 만으로는 부족하다.** 게이트가 엉뚱한 이유로 죽어도 red 다 — 그게 정확히
  verify-network-off 가 앓던 병이다. 기대 메시지 조각까지 맞아야 통과로 친다.
- **양성 대조군을 같이 돈다.** 무엇에나 red 를 내는 하네스는 무엇도 증명하지 않는다.

정적 판정도 한 겹 더 조였다 — `gate-liveness.sh` **검사 4 신설**: 검사 1~3 은 전부 npm
스크립트의 배선만 보는데, `scripts/gates/*.sh` 자신은 npm 을 안 거치고 직접 불리므로 그 층
전체가 사각지대였다. negative-control.sh 를 CI 에서 조용히 빼도 아무것도 red 가 되지
않았을 것이다. 신설 직후 이 검사가 스스로 그 상태를 지목했다(배선 전이었으므로).

## 2) 모든 게이트에 음성 대조군

테스트 스위트에 대해 그 역할을 하는 것이 mutation testing 이다. 리뷰의 지적 그대로였다 —
**실패 능력을 재는 도구 자신이 배선 안 된 채 엉뚱한 데를 겨누고 있었다.**

- 배선: CI `nightly-mutation` (schedule + workflow_dispatch). `continue-on-error` 를 **안 붙였다** —
  붙이면 red 를 낼 수 있어도 아무것도 막지 못하고, 그건 같은 결함의 또 다른 형태다.
- 재조준: 정책 파일 2개 → + money/accounting 5개 (tier-gate 가 guarded 로 잡는 그 경로).
- 실측 baseline **61.55%** (2,026 mutants, 4분 25초). 파일별: contracts 100.00 ·
  corporate-actions 96.94 · journal 74.62 · runtime-policy 72.24 · transfers 71.43 ·
  network-policy 63.39 · **performance-report 27.92** (no-coverage mutant 379개 =
  그 파일의 80%. 대부분이 테스트에 아예 닿지 않는다). `break: 60` — 여유 1.55pt.
  performance-report 는 이번에 고치지 않는다. 먼저 **보이게** 만드는 것이 목적이다.
- `ignoreStatic` 는 켜지 않았다. static mutant 454개가 시간의 98%지만 끄면 그만큼이 조용히
  집계에서 빠져 점수만 오른다 — "skip 을 pass 로 집계"와 같은 병이다.
- 원장 `test:mutation unwired:` → `wired:.github/workflows/ci.yml`.
- **선언된 제외 1건**: `tests/f8-paper-performance.test.ts` (벽시계 p95 예산). Stryker 는 9러너
  동시 + perTest 계측이라 이 레인에서 그 측정이 부하 의존이 되어 dry run 이 5초 타임아웃에
  걸린다(재현 2회). 실측으로 원인을 좁혔다 — 단독 실행 156~192ms 이고, 내 journal.ts 변경은
  오히려 **더 빠르다**(현재 269~292ms vs HEAD 315~329ms, 각 3회). 즉 회귀가 아니라 레인 특성.
  제외 후 dry run 통과(467 tests). 예산 단언 자체는 `npm run check`·CI PR-fast 에서 그대로
  집행된다. 대가: 그 파일이 죽이던 mutant 만큼 점수가 낮게 나온다 — 숨기지 않는다.
  오탐을 내는 게이트를 초록으로 유지하는 것이 이 작업이 고치려는 바로 그 병이다.

## 3) 정적 층 (A 그룹 대응)

`@typescript-eslint` 규칙이 **0개**였다. next/core-web-vitals 는 React·접근성 규칙이라
"런타임에 조용히 틀린 값이 흐른다" 계열을 하나도 보지 않는다.

프리셋 통째로 켜지 않았다 — 실측 307건이 나오고 그 다음 수순은 항상 일괄 disable 이며,
그건 게이트가 아니라 연극이다. 실제 실패 형태에 대응하는 규칙만 켜고 전부 `error` 로 집행.
`no-unsafe-*` 계열은 `src/**` 에만 (실측: src 19 / tests+scripts 192 — 후자는 대부분 JSON
파싱 단언이라 성격이 다르다). tsconfig: `noImplicitReturns` + `exactOptionalPropertyTypes`.

### 이 층이 즉시 잡은 것

| 건 | 성격 |
| --- | --- |
| `tests/property/stage2c-blind.property.test.ts:244` | `fc.assert(fc.asyncProperty(...))` 미await — **돈 보존 property 가 무엇을 위반해도 초록이었다.** 이 작업 전체가 고치려는 결함의 교과서적 사례 |
| `src/worker/main.ts:18` | `createServer(async …)` 의 반환 Promise 를 아무도 안 받음 → `/ready` 에서 의존성 점검이 reject 하면(= 503 을 내야 할 바로 그 상황) unhandled rejection 으로 워커가 죽는다 |
| `backtest-runner.ts:382` | `Array.isArray` 가 `readonly T[]` 를 `any[]` 로 좁혀 Act 루프 전체가 `any` 위에서 돌고 있었다 — 타입 검사가 조용히 무력화된 구간 |
| `restrict-plus-operands` | 켰는데 **일을 안 하고 있었다** (`allowNumberAndString` 기본 true). 저장소 발견 0건이라 눈치챌 수 없었고 아래 픽스처가 잡았다 |

### 린트 자신의 음성 대조군

켠 규칙 중 넷이 저장소 전체 발견 0건이다. 안 도는 규칙과 잡을 게 없는 규칙은 출력이 같으므로,
고의로 나쁜 픽스처(`tests/fixtures/lint-negative-control.fixture.ts`, 타입은 유효·린트만 틀림)를
두고 `--no-ignore` 로 집어 규칙별로 실제로 걸리는지 확인한다. 스코프는 `--print-config` 로
**해석된** 설정을 본다 — 설정 파일을 읽는 것은 증거가 아니다.

이 픽스처는 도입 첫 실행에서 바로 값을 했다(`restrict-plus-operands`, 위 표).

### 켜지 않은 규칙과 그 이유 (부채)

`@typescript-eslint/no-unnecessary-condition` — 실측 22건(src 16 / tests 6) 중 상당수가 죽은
가드가 아니라 **신뢰 경계의 런타임 백스톱**이었다:

- `credential-vault.ts:38` `envelope.schemaVersion !== 1` — envelope 는 영속 저장소에서
  오는데 타입은 리터럴 `1` 이라고 주장한다. **타입이 거짓말한다.**
- `journal.ts:556` — 주석이 "Runtime backstop for untyped callers" 라고 명시.

이 상태로 error 를 켜면 규칙이 시키는 일은 "진짜 검증을 지워라" 다. 진짜 수정은 규칙이 아니라
타입이다 — 영속·외부 입력을 `unknown` 으로 받아 파싱하면 가드가 필요해지고 규칙도 조용해진다
(parse, don't assert). **후속 티켓.**

## 판별력 실증 (통과가 의미를 가지려면 필수)

| 게이트 | 실증 |
| --- | --- |
| negative-control 전체 | 21 케이스 (red 14 / green 7) 통과 |
| negative-control 자신 | `gate-liveness` 의 3b 판정을 옛 substring 형태로 되돌리자 **정확히 그 케이스 1건만** FAIL, 나머지 20건 유지 |
| gate-liveness 검사 4 | 위조 게이트 디렉터리(`GATE_DIR` override)에 안 불리는 스크립트 → red |
| tier-gate 로컬 탈출구 | `SKIP_TIER_GATE=1` 로도 `--range` 모드는 안 꺼진다 → red |
| eslint 규칙 7종 | 나쁜 픽스처에서 규칙별로 개별 확인 |
| eslint 스코프 | `--print-config src/worker/main.ts` 에서 `no-unsafe-member-access` 가 error(2) |
| blockedReason | 차단 인정 3종 / 거부 5종 (TLS·URL 오타·프로그래밍 오류·문자열 throw·undefined) |
| releaseGitLane | git 없음+선언 없음 → throw, 선언 있음 → 선언된 skip |

## 오라클

- `npm run check` → typecheck·lint 통과, **889 passed / 56 skipped**.
- 잔여 실패 4건은 전부 `tests/t10-blind-{mcp,strategy}.test.ts` — **다른 세션의 미추적 파일**이며
  stage-1 이 기록한 것과 동일하고 변경 전후 동일하다. 보존하고 손대지 않음.
- perf 예산 테스트는 단독 실행 green (Stryker 동시 9러너 부하에서만 타임아웃 — 환경 요인).

## 남은 게이트 (최상위 tier 요구)

- [ ] 다른 계열(codex) 적대 리뷰 — 특히 `no-unnecessary-condition` 부채 판단과
      `exactOptionalPropertyTypes` 사이트별 방향(키 보존 vs 타입 넓히기) 선택
- [ ] blind test-authorship
- [ ] 채택한 지적은 같은 tier 로 2라운드 재공격

## 과대 서술 금지 메모

- 음성 대조군은 **여기 적힌 케이스만** 증명한다. 커버되지 않은 게이트(compose 레인,
  `verify:migrations`, `verify:backup-drill`)는 여전히 정적 원장만으로 지탱된다.
- Stryker 전역 threshold 는 하나뿐이다 — 한 파일을 개선하면서 다른 파일의 단언을 약화시키는
  변경은 총점이 유지돼 통과할 수 있다. 파일별 하한은 미구현.
- 정적 층은 A 그룹의 **형태**(문자열로 시각 비교 등)를 예방하지만, stage-1 의 A1~A4 를
  소급해서 잡았을 규칙은 없다. "정적 층이 A 그룹을 잡는다"고 적지 말 것.
