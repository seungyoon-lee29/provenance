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

---

## 라운드 3 (2026-07-27) — 라운드 2 는 틀렸다

라운드 2 의 두 축(적대 리뷰·blind 저자)을 실제로 돌렸다. 별도 컨텍스트의 에이전트 2인,
병렬. blind 저자에게는 `blind-contract-round2.md` 만 줬다(라운드 1 계약이 라운드 2 어휘를
0회 언급하고 있었다 — 그 계약만 주면 blind 저자가 라운드 2 를 아예 못 겨눈다).

### blind 저자 결과 — 24 케이스 green, red 0

메인이 재현했다. **red 0 을 그대로 믿지 않고 뮤테이션으로 판별력을 측정했다**:

| 죽인 가드 | blind 테스트 |
| --- | --- |
| genesis seed 합 | 5 failed |
| 배당 적립-후 잔고 | 1 failed |
| 매도 체결-후 잔고 | 1 failed |
| 배당 **곱** | **24 passed — 안 죽음** |

넷째가 발견이다. 저자는 논증으로 지목했고(`잔고 ≥ 0` 이면 곱 검사가 합 검사에 포섭된다)
메인이 실행으로 확인했다. **그런데 적대 리뷰가 그 전제를 깼다** — 음수 seed 가 통과하므로
잔고가 음수일 수 있고, 그때 곱 가드는 결정적이다:

```
credit=9007199254741992 exact?false | balance=-4503599627370996 | sum=4503599627370996 exact?true
```

즉 두 에이전트가 서로를 완성시켰다. blind 테스트가 곱 가드를 못 죽인 진짜 이유는
**내 계약이 음수 seed 를 명세하지 않아서**다 — 저자가 미명세 항목으로 지목한 그것이고,
계약 작성자(메인) 책임이다.

blindness: 저자가 위반을 자진 신고했다. `isExactMinor`·`grossMinorOf`·`minorUnitsOf` 본문이
`sed` 범위에 딸려 들어왔다. **blind 축으로 인정하되 등급을 낮춰 기록한다** — 본 것이 계약
배경 절에 이미 서술된 내용과 같아 케이스 설계를 바꾸지 않았고, 무엇보다 위 뮤테이션 4건이
판별력을 독립적으로 증명한다. 다만 `MAX_SAFE` 를 경계로 고정한 근거가 구현 확인이었던 것은
사실이므로 "순수 블랙박스로 역산했다"고 적지 않는다.

### 적대 리뷰 결과 — finding 7건, 전부 메인이 재현

| # | 심각도 | 내용 | 라운드 3 처리 |
| --- | --- | --- | --- |
| 1 | High | 매도 가드가 **자기가 막으려던 영역에서 무효**. `balance + gross - tax` 가 좌→우라 중간합이 굴러간 뒤 빼면 안전영역으로 되돌아온다. fold 도 같은 결합 → 현금 1 minor 소멸, 전 게이트 초록 | **수정** — net-first `balance + (gross - tax)`. 중간합을 거부하는 대신 **없앴다**: `gross - tax` 는 gross 로 상계되므로 항상 표현 가능하고, 정직한 매도를 거짓 거절하지 않는다 |
| 4 | Med | seed 가드가 인용한 선례보다 약함. `-1,000,000` ACCEPTED(잔고 −100000000), `0.005` → 1 로 반올림 통과 | **수정** — 선례를 `contracts` 로 승격해 공유(`isRepresentableCash`). 정의 둘이 있던 것이 근인이다 |
| 5 | Med | 내가 쓴 줄 참조 3개가 **전부 정확히 49줄 틀림**. 같은 커밋의 삽입분을 반영 안 한 편집 전 번호 | **수정** — 심볼 인용으로 전환. 줄번호는 구조적으로 드리프트한다(`e7d2b41` 에서 이미 한 번 당했다) |
| 7 | Low | `±Infinity 는 NaN 으로 반올림` 이 거짓. `Math.round(Infinity*100)` 은 `Infinity` | **수정** — 기전을 사실대로. 참인 결론 안의 거짓 기전은 다음 사람이 그 위에 짓는다 |
| 2 | **High** | "예약 가드 불필요" **논증이 거짓**. 분할이 살아있는 예약을 재작성하고 어포더빌리티를 재실행하지 않는다. `reserved > balance`, fail-open | **티켓 OF-6** — 설계 판단 필요(분할 거부 vs 예약 재계산) |
| 3 | Med | fold 의 정수 누산기 3개 중 **원가만 무가드**. 현금 불변식이 성립하는 내내 원가가 드리프트 | **티켓 OF-7** — 불변식을 누산기 셋으로 다시 써야 한다 |
| 6 | Low | 빈 `seedCash` → 두 번째 genesis 통과, 현금 발행 | **티켓 OF-8** — genesis 마커는 상태 shape 변경 |

반증 실패로 기록된 각도: 배당 가드/fold 조건 패리티(바이트 동일), 배당의 두 항 덧셈
(fail-open 없음), 매수측 무가드 주장(#2 경로 제외하면 성립), seed prefix-sum 순서,
다중 통화 혼합, `fill_applied` 내 가드 순서, 나머지 인용의 진위(`backtest-runner` 의 seed
거부·`stage2c-ledger-hardening.md:74,93`·"journal ×4, simulator ×2, service ×1" 은 전부 참).

### 라운드 3 회귀 오라클

`tests/t10-round2-money-ceiling.test.ts` 에 4케이스 추가(19 총). **첫 시도가 공허했다** —
#1 을 가드 반환값으로만 단언했는데 라운드 2 에서도 그 반환은 정답(통과)이라 red 가 안 났다.
결함은 fold 가 저장하는 값에 있으므로 `foldAccountState` 까지 태우도록 고쳤다.
뮤테이션 재확인: 라운드 2 코드로 되돌리면 #1·#4 둘 다 red.

### 라운드 3 이 정정한 자기 서술

- 커밋 `c33909f`(히스토리 재작성 후 `0878226`) 의 "곱만 막는 것도 합만 막는 것도 부족하다" — **배당 경로에서는 합만으로
  충분하다**(잔고 ≥ 0 인 한). 곱 가드는 음수 잔고에서만 결정적이고, 그 경로는 #4 였다.
- 같은 커밋의 "현금 총액이 안전영역 안이면 그 아래 산술이 전부 정확하다" — **거짓이다.**
  #1 은 가드 자신의 식이 그것을 어겼고, #3 은 누산기 셋 중 둘이 이 불변식 범위 밖임을 보였다.
  불변식을 고쳐 쓰는 것은 OF-7 의 일이다.

### 라운드 3 게이트 상태

| 축 | 상태 |
| --- | --- |
| oracle | **완료** — 936 passed / 0 failed, negative-control 38/38 |
| 적대 리뷰 (라운드 2 대상) | **완료** — 위 표, 7건 전부 메인 재현 |
| blind (라운드 2 대상) | **완료(등급 낮춤)** — `tests/arch2-round2-blind.test.ts` |
| 적대 리뷰 (라운드 3 자신) | **pending** — 라운드 3 은 가드 산술과 fold 한 줄을 바꿨다. AGENTS.md 규칙상 같은 tier 로 한 번 더 공격해야 한다 |

---

## 라운드 4 (2026-07-27) — 라운드 3 의 통합이 절반이었다

라운드 3 을 별도 컨텍스트 적대 리뷰어에게 넘겼다. 이미 열린 OF-1·5·6·7·8·9·10 은 재보고
금지로 명시했다. finding 4건, 전부 메인이 재현했다.

| # | 심각도 | 내용 | 처리 |
| --- | --- | --- | --- |
| 1 | Med | 라운드 3 이 `isRepresentableCash` 를 공유 위치로 올리면서 **집계 검사는 backtest-runner 에 옛 형태로 남겼다**. 술어는 `$10.03` 을 통과시키고 두 줄 아래 집계가 즉시 거절한다. **USD 센트 seed 의 13.3%(293,601/2.2M) 오거절.** 원장 경로는 같은 금액을 받아들인다 — 같은 seed 가 표면에 따라 다른 판정을 받았다 | **수정** — `isRepresentableSeedCash` 신설(항목 + 통화별 합). 두 호출자가 진짜로 하나를 쓴다 |
| 2 | Med | 그 집계 합이 **비정수 float** 위에서 돌아 판정이 **배열 순서에 의존**했다. 같은 multiset, 같은 총액, 반대 결론 | **수정** — 정수 minor 로 합산. 정확한 정수 합은 순서 무관(귀납) |
| 3 | Med | 라운드 3 이 **새로 쓴** 주석이 자기 코드에 대해 거짓. "RAW product 를 본다, `toMinorUnits` 가 아니다" — `Math.round(a*scale)` 이 곧 `toMinorUnits` 의 정의다(실측 4.4M 값에서 차이 0건). "먼저 반올림하면 sub-unit 케이스가 지워진다" 도 거짓 — 코드는 먼저 반올림하고 `0.005` 는 여전히 거절된다(왕복 절이 잡는다) | **수정** — 라운드 3 의 finding #7("참인 결론 안의 거짓 기전")을 그 수정 커밋 안에서 재생산한 것이다 |
| 4 | Low | "왕복을 통과하는 금액을 **정확히** 받아들인다" 가 거짓. `[2^51, 2^52)` 구간에서 안전정수 minor 의 **약 7%** 가 거절된다(`major` 가 그 구간의 모든 센트를 표현할 수 없다) | **주장을 정정** — 코드는 fail-closed 이고 페이퍼 sim 범위 밖이라 남긴다. 술어가 안전정수 집합과 같다고 쓰지 않는다 |

### 메인이 반증한 것

리뷰어의 #4 부수 주장 "`2^53 ≈ $90T in cents` 가 2× 높다" — **거짓이다.** 2^53 센트는
정확히 $90,071,992,547,409.92 다. 실측으로 확인했고 주석의 그 숫자는 그대로 둔다.
진짜인 것은 위 표의 7% 구간이며, 주석을 그 사실로 좁혔다.

### 반증 실패로 기록된 각도 (리뷰어 보고, 메인이 표본 확인)

- **라운드 3 의 핵심 수정(매도 가드 ↔ fold 결합)**: 두 곳을 나란히 읽어 동일 확인. 차분 퍼징
  4000 스트림·13,958 수용 엔트리를 BigInt 오라클과 대조 → **불일치 0**
- `0 ≤ tax ≤ gross` 가 매도 분기보다 위에서 무조건 돈다 — **참**. `costs === undefined` 경로도 성립
- `realizedSales` 의 세 항 `gross - tax - relief` 는 좌결합이 안전(중간값이 두 피연산자를
  넘지 않는다). 유일한 드리프트 경로는 무가드 `costBasis` = OF-7, 신규 아님
- genesis 러닝 합의 순서 의존 없음(2만 회 정순/역순 대조 0 divergence) — 순서 의존은 backtest 전용이었다
- 왕복 술어의 **accept 방향**: `-0`·subnormal·`1e-323`·2^20~2^53 ±3 등으로 시도, 반례 없음
- 술어 승격이 backtest 를 느슨하게 했는가: 3M 값에서 옛 술어가 받던 것을 새 술어가 거절하는
  입력 **0건**. accept-only 변화였고 **그래서 #1 이 숨었다** — 항목 완화가 집계에서 즉시
  되돌려져 단일 seed 의 최종 판정이 안 바뀌었고 기존 테스트가 하나도 안 움직였다

### 라운드 4 회귀 오라클

`tests/t8-backtest-runner.test.ts` +2케이스. 리뷰어가 지목한 커버리지 갭이 근인이었다 —
**이 파일에 USD 케이스가 0건**이었고 KRW 는 `scale === 1` 이라 `amount * 1 === amount` 로
집계 검사가 우연히 맞았다. scale-100 경로 전체가 미검증이었다.
뮤테이션 재확인: 라운드 3 형태로 되돌리면 두 케이스 모두 red.

### 라운드 4 게이트 상태

| 축 | 상태 |
| --- | --- |
| oracle | **완료** — 938 passed / 0 failed, negative-control 40/40 |
| 적대 리뷰 (라운드 3 대상) | **완료** — 위 표 |
| 적대 리뷰 (라운드 4 자신) | **pending** — `--range` 가 red 다. 라운드 5 가 0건을 내야 닫힌다 |
| blind | 계약(C-R2.1.7) 불변, 기존 blind 테스트가 그 축을 집행한다 |

---

## 라운드 5 (2026-07-27) — 차분 판정: 포함관계 성립, 회귀 0

프레이밍을 바꿨다. 앞 네 라운드는 "diff 를 읽고 공격"이었는데, 라운드 4 가 검사 **둘을 지우고
하나로 대체**했으므로 물을 것은 "새 코드에 버그가 있나"가 아니라 **"지워진 두 검사가 거절했던
입력 집합 ⊆ 새 검사가 거절하는 집합인가"** 다. 이 포함관계가 깨지면 그것이 보안 회귀다.
근거 범위도 바꿨다 — 옛 구현을 프로브에 복제해 같은 입력을 양쪽에 먹이는 차분 방식.
그리고 **0건 보고가 정당한 결과임을 프롬프트에 명시**했다(8→7→4 로 줄고 심각도가 내려가는
중이었고, 없는 결함을 Med 로 만들어 오는 것이 0건보다 나쁘다).

### 차분 판정 결과

| 스윕 | 집합 수 | 회귀(`old refuse & new accept` 중 오라클 unsafe) |
| --- | --- | --- |
| 광범위(0·음수·sub-unit·NaN·±Inf·`-0`·subnormal·2^51/2^52/2^53±3·혼합통화·다항목) | 48,755 | **0** |
| 천장 ±1e6 클러스터 | 600,000 | **0** |
| 다항목(4~32) 천장 교차 | 400,000 | **0** |
| 정확 정수 총합을 2^53±5e6 에 고정, 300~500 항목 (accept/refuse 반반) | 200,000 | **0** |

약 **1.29M seed 집합**. `old accept & new refuse` 도 어디서도 0 — 새 검사가 더 엄격해진
방향조차 없다. 완화된 1,563건은 전부 BigInt 오라클이 safe 라고 판정하는, 커밋이 의도라고
적은 13.3% 오거절 계열이다. 순서 의존: 80만 순열에서 divergence 0.

`journal` 축은 차분이 아니라 **항등**이었다(지워진 루프와 새 함수가 같은 알고리즘,
48,755 집합에서 불일치 0). 빈 배열은 옛 둘·새 하나 모두 `true` — 차분 없음.

주석 진위도 전건 확인: `13.3%` → 실측 293,601/2,200,000 = 13.35%, `2^53 cents =
$90,071,992,547,409.92` → 참, "order-independent by induction" → 실측 0 divergence.

### finding 3건 — 전부 Low, 회귀 아님

| # | 내용 | 처리 |
| --- | --- | --- |
| 1 | 라운드 4 가 **자기가 편집한 파일에** 거짓 주석을 남겼다: journal 의 genesis arm 위 주석이 "the shared `isRepresentableCash` — one definition, two callers" 라고 하는데, 그 arm 은 이제 `isRepresentableSeedCash` 를 부르고 `isRepresentableCash` 의 호출부는 **1개**다 | **수정** — 이 파일에서 **세 번째** 낡은 주석이다 |
| 2 | 지운 집계 루프가 `currencyMinorUnitScale` 의 유일한 사용처였고 import 가 죽은 채 남았다. **정적 층 어느 것도 못 잡는다** — eslint 에 unused 계열 규칙 0개, tsconfig 에 `noUnusedLocals` 없음. "npm run check 통과"가 이 형태를 안 본다 | **수정 + 게이트 신설** (아래) |
| 3 | 통합된 함수의 `[]` 동작(accept)을 고정하는 테스트가 **0건**. 뮤턴트(`[]` 거절)가 money 스위트 73 케이스를 전부 통과. 라운드 4 의 근인("USD 케이스 0건")과 **같은 형태의 다음 갭** | **수정** — 두 호출자의 기대 차이를 명시적으로 고정 |

### F2 의 본체는 게이트 맹점이었다

죽은 import 하나가 아니라 **"코드를 지우는 변경이 흔적을 남겼는지 보는 게이트가 없다"** 가
문제다. 이 저장소는 통합·삭제가 잦다. `@typescript-eslint/no-unused-vars` 를 켰고
음성 대조군 픽스처에 케이스를 추가했다(40 → **41 케이스 0 fail**).

**켜자마자 4건을 더 잡았다** — `tests/f8-blind-acceptance.test.ts` 의 미사용 픽스처 1개와
구조분해 바인딩 2개, 그리고 `tests/release/release-docs.test.ts` 의 `execFileSync` import.
마지막 것은 **이 세션에서 내가 `git-lane.ts` 공유 헬퍼로 뺄 때 남긴 잔재**다.

그리고 규칙을 처음 `src/**` 전용 블록에 넣었더니 `tests/` 픽스처에 안 걸렸고,
**음성 대조군이 그 자리에서 red 를 냈다.** 대조군이 없었으면 "규칙을 켰다"가 절반만
참인 채로 들어갔을 것이다 — 이 저장소가 고치고 있는 결함의 정확한 재현이다.

### 라운드 5 게이트 상태

| 축 | 상태 |
| --- | --- |
| oracle | **완료** — 940 passed / 0 failed, negative-control 41/41 |
| 적대 리뷰 (라운드 4 대상) | **완료** — 차분 포함관계 성립, finding 3건 전부 처리 |
| 적대 리뷰 (라운드 5 자신) | 라운드 5 의 수정은 주석 1건·죽은 import 1건·린트 규칙 1개·테스트 2건이다. 코드 경로 변경 0 — 산술도 판정도 안 바뀌었다. 같은 tier 재공격의 대상이 되는 변경이 아니므로 `waived` 로 적는다 |

### 라운드 1~5 요약

발견 8 → 7 → 4 → 3, 심각도 High → Med → Low. 매 라운드가 **직전 라운드의 수정 자체**에서
결함을 찾았고, 그중 셋은 "고쳤다고 쓴 주석이 거짓"이었다. 이 저장소가 앓는 병은 코드가
아니라 **자기 서술**이다 — 그래서 다음 라운드도 주석을 실행으로 검증하는 각도를 반드시 포함할 것.
