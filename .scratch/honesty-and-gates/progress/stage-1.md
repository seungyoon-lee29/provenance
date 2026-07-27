# Stage 1 — 정직함 누수(A) + 자기 자신을 통과시키는 게이트(B)

착수 2026-07-27. 계기: arch-2 아키텍처 리뷰 v2(39건) 중 A그룹 4건 + B그룹 4건.
두 그룹을 한 작업으로 잡는 이유는 뿌리가 하나이기 때문이다 — **실패할 수 없는 검증은 검증이 아니다.**
A는 "틀린 값이 covered 로 나간다", B는 "그 값을 잡아야 할 게이트가 자기 자신을 통과시킨다".

## Blast radius / 검증 tier 선언 (collaboration.md 표 기준, 착수 전 필수)

| 축 | 판정 |
| --- | --- |
| 건드리는 경로 | `src/modules/paper-trading/**`, `src/modules/actual-portfolio/calculation/**` — tier-gate guarded 경로 2개 |
| **검증 tier** | **최상위 (자동 승격, 판단 없음)** — money 산술 경로 diff |
| 추론 강도 | XHigh (포트폴리오 회계 + 돈 산술) |
| 되돌릴 수 없음 | **낮다** — 전부 순수 함수의 반환 타입/비교 방식 변경. 외부 부수효과 0, 마이그레이션 0, 저장 포맷 변경 0. 원장에 이미 적힌 이벤트는 재해석되지 않는다(fold 입력 불변) |
| blast radius | 리포트 소비자(CLI `--json`·MCP `call_operation`)가 보는 **필드 shape 변경 1건**(`maxDrawdown`) + 잘못된 세그먼트 배정 교정. 잘못된 값이 이미 나간 적이 있다면 이 변경이 그것을 드러낸다 — 숨기지 않는다 |
| Contain | flag 불필요(기본값 변경 아님). `maxDrawdown` shape 변경은 **파괴적**이므로 README·SKILL.md 동시 갱신이 완료 조건 |

tier 최상위 방법(표 120행): contain 으로 blast radius 를 낮춘 뒤 oracle + 적대 리뷰 + blind test-authorship.
되돌릴 수 없음이 낮으므로 사람 게이트 대신 **다른 계열(codex) 적대 리뷰 + blind 저자**로 간다.

- oracle: `npm run check` (typecheck·lint·test), 파일별 `demo()` self-check
- 적대 리뷰: codex (다른 계열) — 원 작성자가 Claude 이므로
- blind test-authorship: 구현을 안 본 별도 에이전트가 spec 만 받고 반증 테스트 작성
- **채택한 지적은 같은 tier 로 2라운드 재공격** (AGENTS.md 2026-07-26 계기 규칙)

## prior-decisions 조회 결과 (착수 전, tier-gate 트레일러용)

조회 범위: `.scratch/**/progress/*.md`, `docs/adr/`, `docs/notes/2026-07-22-pivot-*.md`.

| 이 작업의 항목 | 걸리는 선행 결정 | 판단 |
| --- | --- | --- |
| A3 gross 곱 정밀도 | `stage2c-ledger-hardening.md:74,93` — "safe-integer(2^53) 초과: 문서화(ponytail), 도메인 상 도달 불가($90조), 필요 시 bigint". pivot `:264` "[T8 전 결정] PaperMoney.amount 는 JS number" | **거스르지 않는다.** BigInt 전면 전환은 제안하지 않음. 다른 축으로 좁힌다 — 아래 참조 |
| A4 maxDrawdown | `t8-backtest-engine.md:386,403` B-B: "비유한·음수 미가드 → null/>1" 을 **비유한 스킵**으로 해결. `t9-performance-surface.md:70-71`: "coverage-타입 불변식이 echo·maxDrawdown 엔 누락 → WindowValue + maxDrawdown 비유한 스킵으로 표면 전체 확장" | **다른 축이다.** 선행 결정이 다룬 것은 *직렬화 정직함*(NaN 이 null 로 새지 않는다). 이번 건은 *인식론적 정직함*(빈 곡선의 `0` 은 "낙폭 없음"이 아니라 "모름")이다. 스킵은 후자를 못 막는다 |
| A1 transfers | `f7-plan.md:42` — "transfers 의 동일 계열 문자열 비교도 **선제 정규화**" | **기록이 실제보다 앞서 있다.** 54–62 행만 정규화됐고 **75 행은 그대로 문자열 비교**다. 결정을 거스르는 게 아니라 미완의 결정을 완료하는 것 |
| A2 corporate-actions | 해당 없음 (none-found) | — |
| B 전체 | `gate-ledger.txt` 헤더 — 이 원장 자체가 arch-1 의 산출물 | 강화지 번복이 아님 |

### A3 의 재정의 (선행 결정을 거스르지 않는 좁은 축)

기각된 것: "gross 를 BigInt 로 바꾼다".
남는 진짜 결함: **이 저장소가 세운 관례가 가장 많이 불리는 곱에만 빠져 있다.**
`t9:54` 는 시드 현금 경계에 `isSafeInteger` 를 집행하고, `t9:66` 는 세금 합에 집행하고,
`t8:397` 는 relief 곱을 BigInt 로 옮겼다. 그런데 `grossMinorOf` — simulator·fold·fill 검증자·
equity mark 가 전부 지나는 단일 곱 — 에는 천장 집행이 **없다**. 문서화된 천장을 경계에서
집행하지 않으면 그 문서는 게이트가 아니라 주석이다(= B 그룹과 같은 병).
추가로 `contracts.ts:36-41` 주석의 "EXACT integer minor units, needs no epsilon" 은
과대 서술이다 — `quantity * price.amount` 는 스케일링 **전** major 단위 float 곱이다.

## 작업 항목

- [ ] A1 `calculation/transfers.ts:75` — 세그먼트 flow 필터가 문자열 비교. 정규화 ms 로
- [ ] A2 `calculation/corporate-actions.ts:47,74,78` — split factor·delisting 최소값·post-delisting 거부 3곳 문자열 비교
- [ ] A4 `backtest/performance-report.ts:136` — `maxDrawdown: number` 만 coverage 타입 아님
- [ ] A3 `internal/contracts.ts:43-60` — 문서화된 2^53 천장을 경계에서 집행 + 과대 주석 교정
- [ ] B1 `gates/gate-liveness.sh:79` — substring 배선 판정 → 실제 호출 형태. `check:pr wired:package.json` 자기참조. `compose:verify`(CI 가 실제로 부르는 게이트)가 원장 밖
- [ ] B2 `gates/tier-gate.sh` — commit-msg 훅에만 있고 CI 대응물 0. 훅 없는 커밋은 무검사 통과
- [ ] B3 `scripts/verify-network-off.ts:36-40` — catch-all 이 "무엇이든 실패하면 차단됨"으로 읽음
- [ ] B4 `.dockerignore` — `.scratch`(에이전트 내부 기록) 가 이미지에 실림. `.git` 제외로 release 테스트가 컨테이너 레인에서 조용히 skip

## 진행

### 구현 완료 (2026-07-27) — `npm run check` green, typecheck·lint 통과

**A1 `transfers.ts`** — 세그먼트 cut 을 문자열이 아니라 정규화 ms 로 비교. `cuts` 는 caller
문자열과 `toISOString()` 이 섞여 있어 오프셋이 다르면 사전순 ≠ 시간순이었다.
겸사로 **같은 줄의 같은 병 하나 더** 닫음: 창 경계 밖 flow 를 비세그먼트 경로는
`flow_outside_window` 로 거부하는데 세그먼트 경로는 어느 세그먼트에도 안 넣고 조용히 버렸다.
flow 시각도 선제 파싱해 `invalid_timestamp` fail-closed.

**A2 `corporate-actions.ts`** — 3곳(`splitQuantityFactor` 비교, 최소 delisting 선택,
post-delisting 거부) 전부 ms 비교. 모듈 경계에서 전 instant 파싱 검사 →
`invalid_timestamp` 를 unavailable 유니언에 추가. `delistedAt ?? ""` 폴백 제거.

**A4 `performance-report.ts`** — `maxDrawdown: number` → `MaxDrawdown` coverage 유니언.
`insufficient_curve`(마크 2개 미만) / `invalid_sample`(비유한·음수).
선행 결정(B-B 비유한 스킵)을 **한 축에서 좁힌 것**이며 근거는 그 문서 자신의 선(t8:352):
진단치는 드롭해도 자기 카운터에 남지만 헤드라인 비율은 안 남는다. MDD 는 헤드라인이다.
B-B 가 지키던 성질(어떤 필드도 null 로 새지 않는다)은 `unavailable` 로 **더 강하게** 유지.

**A3 `contracts.ts` + 6개 호출부** — 재정의한 좁은 축 그대로:
- `grossMinorOf` 가 "simulator·fold·fill 검증자가 공유하는 단일 정의"라고 주장하는데
  **6곳이 같은 식을 손으로 다시 쓰고 있었다**(journal ×4, simulator ×2, service ×1 중
  중복 제외). 전부 `grossMinorOf` 로 통합 — 통화 인자가 모두 그 가격 자신의 통화임을
  개별 확인 후 drop-in.
- `isExactMinor` 신설 + journal fill 경계에서 집행. 시드 현금(t9:54)·세금 합(t9:66) 에
  이미 있던 관례를, 가장 많이 불리는 곱에만 빠져 있던 것을 메운 것.
- "EXACT integer minor units, needs no epsilon" 과대 주석 교정.

> **실측 결과 (중요)**: t9 C1 세금-합 드리프트 E2E 픽스처가 도달 불가가 됐다.
> 기전 확인 — 그 픽스처의 마지막 매도는 gross ≈ **1.99e16 (2^53 의 2.2배)** 였고,
> 기존 원장은 그 체결을 **받아들인 뒤** 세금 합계 단계에서야 이상을 알아챘다.
> 새 가드는 같은 결함을 한 단계 상류에서 잡는다. 테스트는 "상류에서 거부됨"을 단언하도록
> 다시 씀. 하류 `invalid_total` 가드는 순수 레벨 회귀(t8-performance-report.test.ts:285)로
> 그대로 남아 defence in depth.

**남은 갭 1 (이번 범위 밖, 후속)**: fold 의 **현금 잔고 합** 자체는 여전히 2^53 미집행이다.
위 픽스처에서 잔고가 1.3e16 까지 갔다. 곱은 집행하고 합은 안 하는 비대칭이므로
"천장이 집행된다"고 과대 서술하지 말 것. → 후속 티켓 후보.

**남은 갭 2 (라운드 2 후보, 실측으로 발견)** — `Date.parse` 는 정직한 instant 검사가 아니다:

| 입력 | `Date.parse` 결과 |
| --- | --- |
| `"2026-02-30T00:00:00Z"` | **NaN 아님** → `2026-03-02T00:00:00Z` 로 조용히 굴러감 |
| `"2026-02-29T00:00:00Z"` (평년) | → `2026-03-01T00:00:00Z` |
| `"2026-01-01T00:00:00"` (오프셋 없음) | **머신 로컬 존**으로 해석 → 결과가 기계마다 다름 |

`backtest-runner.ts:184-198` 에 이미 `hasTimezone`·`isCalendarDate` 가 있고 둘 다 과거
codex 게이트의 산물이다. 그런데 **사유 함수로 그 파일 안에 갇혀 있고**, 수익률 계산 경로
(`corporate-actions`·`transfers`·`performance`)에는 없다. A1/A2 가 추가한 `invalid_timestamp`
가드는 "파싱 가능"만 본다 — 그 이상을 주장하지 않도록 주석을 즉시 좁혔다(과대 서술 방지).
**라운드 2 에서 공유 위치로 승격 + 3개 모듈에 적용**. 지금 안 하는 이유는 적대 리뷰·blind
저자가 현재 diff 를 대상으로 진행 중이고, 채택 수정은 어차피 같은 tier 로 재공격해야
하기 때문이다(AGENTS.md 2026-07-26 규칙) — 라운드를 섞지 않는다.

**B1 `gate-liveness.sh`** — 3b 판정을 substring → `npm run <script>` 호출 형태 + 주석 줄 제외.
3c 신설(훅·CI 가 실제로 부르는 스크립트는 이름 접두사 무관 전부 원장에).
조이자마자 두 결함을 스스로 지목: `check:pr wired:package.json` 자기참조,
그리고 CI 의 PR-integration 레인 전체를 돌리는 `compose:verify` 가 원장 밖.
→ CI 가 collaboration.md 가 규정한 이름(`check:pr`)을 부르도록 배선을 실재화.
`.husky/pre-commit` 의 "주석에 스크립트 이름 안 쓰기" 규율은 기계화됐으므로 폐기.

**B2 `tier-gate.sh`** — `--range` 모드 + CI pr-fast 스텝. 훅은 로컬 산물이라
`--no-verify`·훅 미설치 클론·웹 UI 커밋이 무검사 통과했다. 로컬 `SKIP_TIER_GATE` 는
흔적이 없어 range 모드에서 안 통하고, 대신 기록이 남는 `Tier: skip (사유)` 형태 신설.
폴백을 루트 커밋이 아닌 `HEAD^` 로 좁힘 — 트레일러 형식이 2026-07-26 에 바뀌어
옛 커밋을 소급 판정하면 거짓 red.

**B3 `verify-network-off.ts`** — catch-all 이 "무엇이든 실패 = 차단됨"으로 읽던 것을
차단의 증거가 되는 실패만 수용하도록. `blockedReason` 분리 + 엔트리포인트 가드.

**B4 `.dockerignore` + `tests/release/git-lane.ts`** — `.scratch`(내부 문서고)·`.claude`·
`dist`·`playwright-report` 제외. `hasGit()` 사본 3개 → 공유 헬퍼 1개로,
그리고 **조용한 skip → 선언된 skip**: git 없는 레인은 `RELEASE_LANE_WITHOUT_GIT=1` 로
축소 커버리지를 명시하고, 그 밖의 환경에서는 시끄럽게 실패한다.
compose `pr-check` 이 그 선언을 갖는다.

### 판별력 실증 (게이트가 실제로 red 가 되는지 — 통과가 의미를 가지려면 필수)

| 게이트 | 실증 |
| --- | --- |
| gate-liveness 3b | 위조 원장 `check:pr wired:package.json` → red. 실 원장 → green |
| gate-liveness 3c | 위조 원장에서 CI 가 부르는 `test:browser`·`test:performance` 누락 → red |
| tier-gate --range | 현행 트레일러 형식 이전 커밋 `5cab9f0` 포함 범위 → red (guarded 2파일 지목). `HEAD~10..HEAD` → green |
| tier-gate 트레일러 정규식 | 사유 없는 `Tier: skip ()` → 거부. `Tier: skip (사유)` → 수용 |
| verify-network-off | 6 케이스 프로브: ENOTFOUND·ECONNREFUSED(AggregateError)·AbortError → 차단 인정. TLS 검증 실패·URL 오타·문자열 throw → **거부**(전에는 전부 "통과") |
| release git-lane | 가짜 `git`(exit 127) + 선언 없음 → 수집 에러로 red. `RELEASE_LANE_WITHOUT_GIT=1` → 선언된 skip 1건 |
| maxDrawdown | 빈 곡선·단일 마크·비유한·음수 각각 `unavailable`, 평탄 4마크는 covered 0 |

### 오라클

`npm run check` → typecheck·lint 통과, **823 passed / 56 skipped**.
잔여 실패 4건은 전부 `tests/t10-blind-{mcp,strategy}.test.ts` — **다른 세션의 미추적 파일**이며
변경 전후 동일하다(MCP 스키마 `additionalProperties` 미집행, 인자 없는 tool 호출,
CLI 엔벨로프 `command` 필드, 주문이 0개 발생한 사이징). 내 변경은 체결 검증 단계라
주문 발생 자체를 막을 수 없다. **보존하고 손대지 않음.**

### 게이트 결과 (최상위 tier)

**blind test-authorship (완료)** — `tests/arch2-blind-honesty.test.ts`, 최종 55/55 green.
저자가 red 2건을 남겼고 메인이 각각 재현·판정했다:
- *C3-3 위반 주장* → **반증**. 저자가 "같은 instant" 라고 쓴 `…T09:00:00-09:00` 는
  실제로 18:00Z 다(오프셋 부호 반전). 진짜 같은 instant 4형태(동일 문자열·`.000`·`+09:00`·
  `-05:00`)로 재검하니 전부 정확히 `flow_at_scope_break`. 테스트는 의도를 살려
  parametrized 로 교정하고 전제(`Date.parse` 동일성) 자체를 단언에 포함시켰다.
- *`actionReference` 생략 시 duplicate_action* → **결함 아님**. 그 필드는 타입상 필수
  `string` 이고 저자는 `as any` 로 우회했다. reference 가 곧 동일성의 정의다(f8 패널이
  content-hash 안을 기각한 근거와 같다). **다만 계약 문서가 잘못이었다** — "중복 거부"만
  적고 필수임을 안 적었다. 테스트를 양방향 단언으로 교체.
- blindness 실측 보고: 소스는 안 열었으나 **공개 함수를 블랙박스 실행해 필드명을 역산**했다.
  저자가 자진 공개했고 테스트 파일에도 주석으로 남겼다. 순수 blind 보다 느슨함을 기록한다.
- 저자가 지적한 **계약 미명세 4건**(C1.5 buildPerformance 시그니처, C4 journal 공개 진입점,
  C2.6 reason 문자열, C3 입력 스키마) 때문에 그 축들은 커버되지 않았다 — spec 작성자(메인)의 책임.

**codex 적대 리뷰 (완료)** — 다른 계열, finding 8건 전부 재현 명령+출력 첨부.
메인이 직접 재현한 것: #3·#4·#7·#8 (아래 표), #1 의 배당 드리프트, #2(이미 독립 발견).
반증 실패로 기록된 공격 각도: A3 7곳 동치(KRW/USD/EUR 30만건 비교 mismatch 0),
A1 혼합 window 라벨, A2 정상 오프셋 비교, A4 선행 결정 번복(t8:352 선이 실재함을 확인),
B4 git lane.

| # | 심각도 | 내용 | 상태 |
| --- | --- | --- | --- |
| 4 | Med | `tier-gate --range` 가 `git rev-list` 실패를 빈 루프로 접어 **exit 0**. 게이트 입력 오류가 green | **수정** — fail-closed. 재현 rc 0→1 |
| 8 | Low | `Tier: skip ( )` 공백 하나로 통과 — "사유를 요구한다"가 거짓 | **수정** — 비공백 1자 요구 + 행끝 anchor |
| 7 | Low | 내 주석의 "six 곳" 이 틀림. 실제 7곳 | **수정** — diff 로 세어 SEVEN 으로 정정 |
| 1 | Med | `isExactMinor` 가 **곱만** 막는다. 배당(`quantity × perShare`)과 현금 잔고·예약 **합**은 미검사 → 배당 1원 드리프트, 잔고가 안전영역 밖일 때 어포더빌리티 fail-open | **라운드 2** (설계 필요) |
| 3 | Med | `gate-liveness` 3b 가 "실행"이 아니라 문자열 존재를 본다. `echo "npm run check:pr"` 를 배선으로 인정하고, **`tr -d '[]'` 가 깨진 토큰 `npm r[u]n` 을 `run` 으로 복구**해 인정. 유효한 line-continuation 은 거부 | **라운드 2** (파일 소유 충돌) |
| 5 | Med | CI 폴백이 `HEAD^` 라 여러 커밋이 한 번에 들어오면 앞쪽 guarded 커밋을 놓침 | **라운드 2** (파일 소유 충돌) |
| 6 | Med | `blockedReason` 이 구조화 코드가 아니라 `inspect().includes()`. 메시지 안 우연한 문자열로 green, 진짜 정책 차단 `EACCES`/`EPERM` 은 red. 자체 2초 abort 는 "route dropped" 증거가 아님(열린 네트워크의 느린 응답도 green) | **라운드 2** |
| 2 | Med | `Date.parse` 가 `2026-02-30` 을 3월 2일로 승격 (= 위 "남은 갭 2") | **라운드 2** |

재현 요지(메인 실측):
```
tier-gate --range definitely-not-a-ref..HEAD  → rc=0   (수정 후 rc=1)
'Tier: skip ( )'                              → 통과   (수정 후 거부)
'run: echo "npm run check:pr"'                → 배선 인정
'run: npm r[u]n check:pr'                     → tr 이 복구해 배선 인정
배당: qty=2^53-1, perShare=3 → 정확 …973 vs 저장 …972, isSafeInteger=false 인데 무검사 통과
```

### ⚠ 동시 편집 충돌 (사용자 판단 필요)

작업 중 **다른 세션이 같은 파일들을 편집**했다 — `scripts/gates/gate-liveness.sh`(검사 4 추가),
신규 `scripts/gates/negative-control.sh`, `.github/workflows/ci.yml`(negative-control·
nightly-mutation job), `stryker.config.mjs`(mutate 대상을 money 경로로 확장), 그리고 원장.
내용은 **충돌이 아니라 같은 작업의 연장**이고(내 검사 1–3 이 못 보던 "게이트 스크립트 자신"
층을 검사 4 가 닫는다), `negative-control` 13/13 이 **내 게이트 5개를 독립적으로 검증**한다.
그러나 AGENTS.md "한 파일의 owner 는 언제나 한 명" 이 깨진 상태라
**`gate-liveness.sh`·`ci.yml`·`stryker.config.mjs` 는 내가 stage 하지 않는다.**

---

## 라운드 2 — #1 (money fold 합·곱 미검사)

**Blast radius / 검증 tier**: 최상위 (money 산술 경로 자동 승격). 되돌릴 수 없음 = low —
순수 검증 함수에 거절 분기를 추가할 뿐 저장 포맷·마이그레이션·부작용 없음.
Blast radius = `validateSystemBody` 가 거절하는 입력 집합이 넓어진다(= 지금까지
조용히 통과하던 것이 `refused` 로 바뀐다). CLI·MCP 는 거절 이유를 그대로 노출한다.

### 메인이 직접 재현한 것 (probe-sums.mts, probe-sums2.mts)

| 주장 | 결과 |
|---|---|
| 배당 곱 드리프트 (codex #1) | **재현** — qty=2^53-1, perShare=3 → 정확 `27021597764222973`, 저장 `…972` |
| 곱 검사로는 못 잡는다 (내 프로브 라벨) | **반증** — `isExactMinor(…972)` 는 `false`. 곱 검사가 잡는다. 내 라벨이 틀렸다 |
| 어포더빌리티 fail-open (codex #1), 차가 작을 때 | **재현 실패** — balance 2^53+2, reserved 2^53-1 → available 3 정확, 4 는 정상 거절 |
| 같은 것, 차가 클 때 | **재현** — balance 2^54, reserved 1 → available `…984` 로 읽히나 실제 `…983`. `…984` 요구가 승인됨 |
| 적립 증발 | **재현** — balance 2^53 에 +1원 → 잔고 불변, 1원 소멸 |

즉 codex #1 은 확정. 단 전제는 **잔고 자체가 안전영역 밖으로 나간 뒤**다 —
차가 작으면 부동소수 뺄셈은 정확하므로 fail-open 이 아니다. 내 첫 구성이 그 경우였다.

### 메인이 스스로 발견한 것 (codex 가 지적하지 않음)

`journal.ts:366` 에 내가 적은 **"already enforced on seed cash and on the tax sum" 은 거짓이다.**
seed cash 안전정수 검사는 `backtest-runner.ts:237-243`(`invalid_seed_cash`) 에만 있고,
원장 경로 `provision → appendSystem → validateSystemBody` 의 `account_opened`(:282) 는
이미 열렸는지만 보고 **seed 금액을 전혀 검사하지 않는다**. 라운드 1 이 고치려던 병
("문서화된 한계를 아무도 검사하지 않는다")을 내 주석이 그대로 반복했다.

### 설계 — 불변식 하나, 경계 하나

fold(:758-948) 는 **의도적으로 재검증하지 않는다**(:763-768, 2026-07-25 적대 재게이트 기록).
그 결정을 되살리지 않는다. 가드는 이미 거절 채널을 가진 append 경계에 붙인다.

지킬 불변식: **현금 총액은 안전정수 영역을 벗어나지 않는다.**
잔고가 2^53 안에 있으면 그 아래 덧셈·뺄셈은 전부 정확하므로 fail-open 도 적립 증발도
성립하지 않는다. 예약 합은 별도 가드가 필요 없다 — service.ts:378 의 어포더빌리티가
`required ≤ balance - reserved` 를 강제하므로 `reserved_new ≤ balance` 로 묶인다.
잔고를 막으면 예약은 따라 막힌다.

적용 지점 (전부 `validateSystemBody`):
- `account_opened` — 통화별 seed 합 → `invalid_seed_cash` (backtest-runner 와 같은 어휘)
- `dividend_applied` — 곱 `quantity × perShare`, 그리고 적립 후 잔고 → `invalid_adjustment`
- `fill_applied` — 체결 후 잔고 (곱은 라운드 1 에서 이미 :372) → `invalid_fill`

### 라운드 2 구현 완료 (2026-07-27)

세 가드 전부 `validateSystemBody` 에 들어갔다. 오라클: `npm run check` → typecheck·lint 통과,
**908 passed / 0 failed**.

**테스트**: `tests/t10-round2-money-ceiling.test.ts` 15케이스. 구성 원칙 둘 —
- 각 거절 케이스마다 **양성 대조군**을 짝지었다(여유 있는 잔고, 다른 통화, 평범한 배당).
  무엇에나 거절하는 가드는 아무것도 증명하지 않는다.
- 맨 앞에 **전제 확인** describe 를 뒀다: 2^53 밖에서 곱이 이웃 정수로 굴러가고 +1 이
  증발한다는 것을 먼저 단언한다. 같은 날 음성 대조군에서 "위반인 줄 알았던 픽스처가
  사실은 위반이 아니었던" 함정을 밟았기 때문이다(`const` 가 초기화값으로 CFA 좁힘을
  받아 union 이 유지되지 않았다). 전제가 깨지면 아래 케이스 전부가 무의미해진다.
- 셋 중 넷째 describe 는 실제 `PaperJournal.appendSystem` 을 태운다. 순수 함수가 옳아도
  아무도 안 부르면 가드가 아니다.

**주석 정정**: 라운드 1 이 `journal.ts:366` 에 적은 "already enforced on seed cash and on
the tax sum" 은 거짓이었다. 그 문장을 지우고, **무엇이 어디서 집행하는지와 이 거짓이
어떻게 생겼는지**를 같이 적었다 — grep 하지 않고 집행자를 지목하는 것이 이 작업이 고치던
결함의 한 층 위 버전이다. `contracts.ts` 주석도 같은 정정.

### 라운드 2 게이트 상태 (정직하게)

| 축 | 상태 |
| --- | --- |
| oracle | **완료** — npm run check 908 passed, staged-tree-check 통과 |
| 적대 리뷰 | **pending** — 라운드 2 는 codex #1 을 반영한 수정이다. AGENTS.md 2026-07-26 규칙이 요구하는 "같은 tier 로 재공격"이 아직 없다 |
| blind test-authorship | **pending** — 위 테스트의 저자는 구현자 본인(메인)이다. blind 가 아니다 |
| standards | 완료 — `.scratch/honesty-and-gates/blind-contract.md` |

두 pending 은 트레일러에 그대로 적는다. tier-gate 의 pending 2층 규칙에 따라 **PR 범위에서
red 가 된다** — 그게 맞다. "나중에 한다"의 나중이 오게 만드는 것이 그 규칙의 목적이다.
