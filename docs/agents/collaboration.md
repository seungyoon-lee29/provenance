# Agent Collaboration

## 기본 원칙

- 메인 에이전트는 사용자 의도를 해석하고 작업의 범위, 우선순위, 위험과 실행 방식을 결정한다.
- 메인 에이전트는 전체 결과와 최종 응답에 책임을 진다. 작업을 위임해도 판단과 검증 책임은 이전되지 않는다.
- 서브에이전트에는 목표와 경계가 명확하고 독립적으로 수행할 수 있는 작업을 위임한다.
- 규모가 작거나 순차 의존성이 큰 작업은 메인 에이전트가 직접 수행할 수 있다. 위임 자체가 목적이 되어서는 안 된다.
- 아키텍처, 보안, 데이터 손실, 외부 시스템 변경처럼 위험도가 높은 결정과 사용자 승인이 필요한 조치는 메인 에이전트가 직접 판단한다.
- 멀티에이전트는 독립적으로 진행할 작업이 둘 이상이거나 서로 다른 검수 관점이 결과 품질을 실질적으로 높일 때만 사용한다. 단순하고 결과가 결정적인 작업은 메인 에이전트가 직접 수행한다.

## 추론 강도

- 프로젝트 기본 추론 강도는 `High`다. MVP spec처럼 공급자 권리, 인증, 포트폴리오, 주문, 알림과 성능 기준을 통합하는 작업에 사용한다.
- `XHigh`는 인증·비밀 관리·데이터 권리·거래 안전·포트폴리오 회계·삭제/복구·동시성/idempotency처럼 오류 비용이 크거나 되돌리기 어려운 결정, 또는 두 번 이상 실패한 복합 디버깅에만 사용한다.
- 합의된 interface contract 안의 기능 구현, 테스트 작성과 일반 리팩터링은 `Medium` 또는 `High`를 사용한다. UI 스타일, 문서 동기화와 기계적 변경은 `Medium`, 포맷팅과 단순 이름 변경만 `Low`를 허용한다.
- 전체 작업을 항상 `XHigh`로 실행하지 않는다. 추론 강도를 높일 때는 새 추상화를 만드는 대신 확인할 위험, invariant와 검증 oracle을 먼저 적는다.
- 금융 수치, 권한, 실제/모의 구분, 데이터 상태와 외부 전달 경계에는 `Low`를 사용하지 않는다.
- **실행 티어도 리스크에 비례한다**: 탐색·조사·대량 읽기·기계적 변경·합의된 계약 안 구현은 비용이 낮은 실행 tier로 위임한다. 설계·적대 리뷰·판정·중재와 인증·비밀·거래·돈 산술 등 고위험 경로만 주 실행 tier를 유지한다. 낮은 tier에 맡기는 대상은 "찾고 읽고 옮기는" 작업이지 "판단하는" 작업이 아니다.

## 작업 위임

메인 에이전트는 서브에이전트에게 다음 정보를 제공한다.

- 작업 목표와 필요한 배경
- 수행 범위와 제외 범위
- 기대하는 산출물
- 완료 및 검증 기준
- 수정 가능한 파일이나 자원의 범위
- 알려진 의존성, 위험과 제약

병렬 작업은 서로 독립적이고 같은 파일이나 자원을 동시에 수정하지 않을 때만 사용한다. 작업이 겹치거나 선행 결과가 필요한 경우에는 순차적으로 배정한다.

작업 시작 전 메인 에이전트는 frontier ticket을 claim하고 `git status --short --branch`로 기존 변경을 확인한다. dirty worktree가 있으면 사용자 또는 다른 에이전트의 변경으로 간주해 보존하고, 겹치는 파일을 안전하게 소유할 수 없으면 위임하지 않는다.

## 단계별 팀 운영

메인 에이전트는 작업을 시작할 때 의존성 그래프와 critical path를 먼저 확인하고, 실제 병렬화가 가능한 작업만 넓고 얕게 분해한다. 중간 이상 규모의 각 위임에는 다음 항목을 명시한다. 작은 읽기 전용 작업은 같은 내용을 짧게 합칠 수 있다.

- Objective
- Owned Files
- Requirements
- Interface Contract
- Acceptance Criteria
- Out of Scope

팀은 필요한 관점을 모두 포함하는 가장 작은 규모로 구성한다. 일반적으로 단순 작업은 1~2명, 중간 작업은 2~3명, 여러 계층을 가로지르는 복잡한 작업은 3~4명을 사용하며, 이유 없이 5명 이상으로 늘리지 않는다.

중첩 팀을 포함해 동시에 실행하는 서브에이전트 총합에도 상한을 둔다(기본 4~6, rate limit 여유가 없으면 더 낮춘다). 큰 팬아웃은 한 번에 20개+로 던지지 않고 4~6개 배치로 나눠 배치마다 진행 상태를 `.scratch/<effort>/progress/`에 기록한 뒤 다음 배치를 실행한다. 장시간 도구·프로세스에는 timeout과 종료 시 정리(cleanup) 절차를 함께 둔다. 이 조율 규칙은 전역 작업 방식 규칙을 상속하며, 충돌 시 사용자 지시가 우선한다.

아래 하위 단계에서 이름으로 참조하는 스킬(`task-coordination-strategies`·`team-composition-patterns`·`multi-reviewer-patterns`·`parallel-feature-development`·`parallel-debugging`)은 예시 도구다. 규칙은 그 *행동*이며, 스킬이 없거나 이름이 바뀌면 동등한 방법으로 직접 수행한다.

### 설계 단계

- `task-coordination-strategies`로 작업, 의존성, 차단 관계와 critical path를 정의한다.
- `team-composition-patterns`로 중복되지 않는 역할과 최소 팀 규모를 선택한다.
- 고위험 결정(인증·Provider Credential·거래·데이터 권리·핵심 아키텍처 경계)은 서로 다른 관점(architecture/security/performance, UI면 testing/accessibility로 교체)으로 리뷰한다. 영향이 작고 되돌리기 쉬운 결정은 메인 에이전트 또는 1~2명으로 충분하다. 검증 깊이·tier·적대적 decorrelation·격리 방법은 아래 "검증 깊이와 blast radius"를 따른다.
- `multi-reviewer-patterns`로 파일·라인 근거가 있는 finding만 수집하고 중복을 제거한다. 같은 문제의 심각도가 다르면 더 높은 등급을 사용한다.

### 구현 단계

- 독립적인 vertical slice가 둘 이상이고 파일 ownership이 겹치지 않을 때만 `parallel-feature-development`를 사용해 module, vertical slice 또는 directory 단위로 나눈다. 첫 end-to-end tracer나 공유 contract가 아직 움직이는 단계는 메인 에이전트 또는 1~2명이 순차적으로 완주한다.
- 한 파일에는 언제나 한 명의 owner만 둔다. 공유 contract와 barrel/index 파일은 메인 에이전트 또는 지정된 한 명이 소유하며 다른 에이전트는 변경 요청만 보낸다.
- 각 implementer는 합의된 interface contract를 읽기 전용으로 사용한다. 계약 변경은 owner와 메인 에이전트의 승인을 받고 영향받는 에이전트에게 알린 뒤 적용한다.
- 공유 worktree에서는 branch를 전환하지 않고 같은 branch에서 엄격한 파일 ownership을 적용한다. sub-branch는 에이전트마다 별도 Git worktree가 있을 때만 사용하며 메인 에이전트가 통합한다.
- 기본적으로 메인 에이전트만 stage, commit과 push를 수행한다. 서브에이전트는 해당 Git 작업을 명시적으로 배정받은 경우에만 수행한다.
- 서브에이전트는 배정 없이 destructive Git 명령, 전체 저장소 formatter, branch 전환 또는 소유하지 않은 파일 수정을 수행하지 않는다.

### 통합과 오류 해결 단계

- 원인이 명확한 typecheck, lint 또는 단일 테스트 실패는 메인 에이전트나 한 명의 에이전트가 해결한다. 원인이 둘 이상 plausible하거나 여러 module·환경을 가로지르는 결함은 `parallel-debugging`으로 서로 다른 가설을 조사한다. 기본 debug team은 3명이며 같은 가설을 중복 조사하지 않는다.
- 가설은 logic, data, state, integration, resource, environment 범주에서 만든다. 각 조사 결과는 `file:line` 또는 재현 명령 같은 직접 근거와 confidence를 포함한다.
- 메인 에이전트가 결과를 `confirmed`, `plausible`, `falsified`, `inconclusive`로 중재하고 가장 강한 인과관계를 root cause로 채택한다.
- 수정 후에는 원래 재현 실패가 사라졌는지, 관련 edge case와 회귀 테스트가 통과하는지 확인해야 완료할 수 있다.

## 팀 통신

- 일상적인 진행, 질문, handoff와 integration 알림은 해당 에이전트에게 직접 보낸다.
- broadcast는 모든 에이전트가 알아야 하는 critical blocker나 공유 interface contract 변경에만 사용한다.
- 구현자는 계획 승인 대상으로 지정된 위험 작업을 승인받기 전에는 파일을 수정하지 않는다.
- interface나 선행 산출물이 준비되면 의존하는 에이전트에게 즉시 알리고, routine 상태를 반복 보고해 방해하지 않는다.
- 에이전트가 완료되거나 유휴 상태가 되면 새 독립 작업을 배정하거나 종료한다. 종료 전에는 결과와 검증 근거가 저장됐는지 확인한다.
- 에이전트가 중단되거나 완료하지 못하면 blocker, 부분 결과, 변경한 파일, 실행한 검증과 안전한 다음 단계를 보고한다.

## 비밀과 외부 실행 가드

- `.env.local`, `.env`, `.secrets/`, Provider Credential, broker account 식별자와 action token 원문은 읽기·출력·복사 범위를 최소화하고 Git에 stage하지 않는다. 상태 확인은 가능한 한 assignment 이름, configured 여부와 redacted fingerprint만 사용한다.
- 메인 에이전트는 commit 전에 staged file allowlist, `git diff --cached --check`, secret pattern scan과 `.env.local`/`.secrets` 미추적 상태를 확인한다.
- **초록 배지가 무엇에 붙었는지 확인한다 (2026-07-27).** `npm run check`는 **워크트리**를 본다. 이 문서가 요구하는 allowlist stage는 정의상 부분 stage이므로, 초록이 커밋될 트리에 대한 진술이 아닌 경우가 상시로 생긴다. 실측 계기: dirty 워크트리 62파일을 3커밋으로 쪼갤 때 두 커밋이 단독 트리에서 각각 typecheck·lint red였는데 훅은 두 번 다 초록이었다. `scripts/gates/staged-tree-check.sh`가 인덱스≠워크트리일 때만 스테이지된 트리를 따로 검사해 이것을 기계화한다 — 규율이 아니라 게이트다. **알려진 천장**: 훅은 로컬 산물이라 `--no-verify`·훅 미설치 클론은 여전히 빠져나간다. tier-gate가 받은 CI 대응물이 이 게이트엔 아직 없다 (open-findings OF-5).
- 일반 PR과 로컬 기본 실행은 실제 provider secret과 외부 egress 없이 scripted adapter를 사용한다. 실제 provider/browser/email smoke는 문서화된 opt-in contract flag와 allowlisted endpoint가 있을 때만 실행한다.
- broker order mutation은 별도 opt-in flag, Paper 환경, 고정 최대 수량/금액과 cleanup 절차가 모두 있을 때만 허용한다. Live Trading route는 별도 사용자 승인과 새 ADR 전까지 존재하거나 호출되어서는 안 된다.
- 외부 메시지 발송, 운영 배포, 실제 주문, 과금이 가능한 API와 제3자 상태 변경은 사용자가 둔 범위와 명시적 실행 gate를 넘어 추론으로 승인하지 않는다.

## 서브에이전트의 책임

- 배정받은 범위 안에서 작업하고 임의로 범위를 확장하지 않는다.
- 저장소의 `AGENTS.md`, 관련 `CONTEXT.md`와 ADR을 확인하고 동일한 규칙을 따른다.
- 가정, 불확실성 또는 차단 요인이 생기면 숨기지 않고 즉시 보고한다.
- 다른 에이전트의 변경을 덮어쓰거나 되돌리지 않는다.
- 완료 후 메인 에이전트에게 다음 내용을 보고한다.
  - 수행 결과 요약
  - 변경한 파일과 핵심 변경 사항
  - 실행한 테스트 또는 검증과 그 결과
  - 남은 위험, 미해결 사항과 추가 판단이 필요한 내용

## 검증 깊이와 blast radius

리뷰·검증의 목표는 "모든 결함을 잡는다"가 아니라 결함이 새어도 되돌릴 수 없는 피해가 없게 하는 것이다. 안전은 세 층으로 확보하며 리뷰(모델 판단)는 그중 한 조각일 뿐이다. 예산이 빠듯할수록 더 나은 리뷰어를 사는 대신 blast radius를 줄인다.

- **Prevent(예방)**: 불법 상태를 타입으로 표현 불가능하게 만든다(`Money`는 branded type, `Real/Mock`·`Paper/Live`는 phantom type → `typecheck`가 강제). 변경은 작고 인터페이스가 좁은 deep module로 유지한다. 결함을 "리뷰가 잡을 것"에서 "존재할 수 없는 것"으로 옮긴다.
- **Detect(탐지)**: 이번 변경과 독립적으로 작성된 oracle을 먼저 돌린다(`typecheck`·lint·`verify:*`·기존 테스트). 도메인 불변식은 `CONTEXT.md`/ADR에서 도출해 property test로 상시 검증한다(돈 보존, scripted 모드 egress 0, Live route 부재 등). 명세 가능한 결함은 여기서 끝내고, 판단 잔여(설계 냄새·새로운 보안 로직·"옳은 걸 만들었나")에만 사람/리뷰어를 쓴다. 같은 에이전트가 이번 변경에서 새로 쓴 테스트는 코드와 블라인드스팟을 공유하므로 decorrelation 근거로 치지 않는다.
- **Contain(격리)**: 되돌릴 수 없는 경로는 flag-default-off, 고정 상한/서킷브레이커, idempotency+reconciliation, Paper-first, soft-delete+복구, audit log로 blast radius를 낮춘다("비밀과 외부 실행 가드"의 broker/egress 규칙을 일반화). 낮출 수 없으면 그 자체가 최상위 위험이다.

**결정 원리: 필요한 decorrelation ∝ 되돌릴 수 없음 × blast radius.** 검증 tier는 코드 경로만이 아니라 *containment 이후 최악 결과의 되돌릴 수 없음*으로 정한다. 이는 "추론 강도"와 같은 위험 축이므로 함께 움직인다 — 되돌릴 수 없음이 크면 추론 강도(XHigh)와 검증 tier(최상위)를 같이 올린다.

| Tier | 트리거 | 방법 |
| --- | --- | --- |
| Low/기계적 | 포맷·이름 변경·문서 | oracle만, 리뷰어 없음 |
| Medium | 계약 안 기능·일반 리팩터 | oracle + 적대 리뷰 1인(별도 컨텍스트). 관점·프레이밍·근거 범위(diff만 / spec+diff / 재현)를 어긋낸다. **finding은 `file:line` + 재현 명령이나 실패하는 테스트가 있어야 접수한다** — 없으면 의견으로 분류하고 수정 근거로 쓰지 않는다 |
| High | 여러 계층 교차·상태/동시성 | 위 + **blind test-authorship**: 코드를 짠 에이전트는 그 acceptance 테스트를 쓰지 않는다. 별도 에이전트가 구현을 안 본 채 Interface Contract/spec만 받고 반증 테스트를 짠다 |
| 최상위 | `auth`·credential·order·migration·money 산술 경로를 건드리는 diff는 판단 없이 자동 승격 | contain으로 blast radius를 낮춘 뒤 위 방법으로 충분하다. 낮출 수 없으면 **사람 게이트(`ready-for-human`)**로 넘기고, 사람이 없으면 통과시키지 말고 티켓을 block 한다. 게이트 자체를 건드리는 diff는 추가로 음성 대조군(`scripts/gates/negative-control.sh`)에서 red 를 실증해야 한다 |

- **Tier 게이트(기계 강제, 2026-07-24)**: 최상위 승격은 선언이 아니라 커밋 훅이 강제한다. `.husky/commit-msg` → `scripts/gates/tier-gate.sh`가 guarded 경로(`paper-trading/`·`db/migrations/`·`platform/persistence/`·`platform/credential-vault/`·`actual-portfolio/calculation/`·`modules/identity/`)를 건드리는 커밋에 `Tier: top (adversarial=…, blind=…, standards=…)` 트레일러를 요구한다. `pending`/`waived:사유`도 통과한다 — 게이트의 목적은 진위 검증이 아니라 **의무를 조용히 지나치지 못하게 하는 것**이다(진위는 리뷰·메인 판단 몫). 도입 계기: T2-b(돈 원장 영속화)가 blind·Standards 축 없이 resolve된 것을 2026-07-24 독립 검증이 발견 — "일회성 검수를 상시 oracle로"라는 이 문서의 원칙이 프로토콜 자신에게 적용되지 않았던 사례. 스치는 커밋의 의도적 우회는 `SKIP_TIER_GATE=1`.
- **반증 산출물 강제**: 리뷰어는 "괜찮아 보임" 대신 반례(실패 테스트/repro)를 제출하거나 "X·Y·Z 각도로 시도했으나 못 만듦"을 명시한다.
- **spec 대조**: 티켓 contract가 아니라 source-of-truth `.scratch/<feature>/spec.md`/PRD에 직접 대조해 "옳은 걸 만들었나"를 확인한다. 불변식 목록·flag 기본값·ADR은 매 diff가 아니라 확정 시 1회 사람이 검증한다.
- **믿기 전 측정**: property/테스트가 실제로 결함을 잡는지 mutation testing으로 사전 점검하고, 게이트를 빠져나간 결함은 "어느 tier가 왜 놓쳤나"를 기록해 tier 배정을 보정한다.
- **Standards 축 1패스**: High·최상위 구현 티켓은 resolve 전 `code-review` 스킬의 Standards 축을 1회 돌린다(티켓당 1회, 배치당 아님). Spec 게이트(blind·적대 리뷰·mutation)는 경계 간 중복 로직의 우선순위 드리프트 계열을 구조적으로 놓친다 — F8 사후 리뷰 v1이 lifecycle pre-validation의 재전달 no-op 위반을 실증(2026-07-18, 27개 mutation·blind·동일 계열 검수를 통과한 뒤 발견).
- **검증 시퀀싱**: contain 명문화 + `verify:*` 가드 + spec 대조를 1차로 한다. 위험과 잔여 불확실성에 따라 타입 불변식 → property test → mutation testing → 독립적인 최상위 검수 순서로 강화한다.

## 검수와 승인

서브에이전트의 결과는 메인 에이전트가 승인하기 전까지 제안된 중간 산출물로 본다. 메인 에이전트는 보고만으로 작업을 승인하지 않는다. 산출물과 변경 내용을 직접 확인하고, 작업의 위험도에 맞는 테스트나 검증을 수행한다.

다음 조건을 모두 충족할 때만 결과를 승인한다.

- 요청한 범위와 완료 기준을 충족한다.
- 테스트와 검증 근거가 충분하다.
- 다른 작업과 충돌하거나 기존 동작을 손상하지 않는다.
- 승인되지 않은 범위 확장이나 위험한 변경이 없다.

기준을 충족하지 못하면 승인하지 않고 문제, 기대 결과와 재검증 방법을 구체적으로 제시해 서브에이전트에게 재작업을 맡긴다. 같은 문제가 반복되면 단순히 같은 지시를 되풀이하지 않고, 메인 에이전트가 작업을 다시 분해하거나 접근 방법을 변경한다. 사용자 결정이나 추가 권한이 필요한 경우에는 작업을 임의로 진행하지 않고 사용자에게 확인한다.

병렬 review 결과는 다음 기준으로 통합한다.

- `Critical`: 데이터 손실, 보안 침해 또는 전체 기능 실패가 확실하거나 매우 가능하다.
- `High`: 주요 기능 또는 보안에 큰 영향이 있고 발생 가능성이 높다.
- `Medium`: 일부 기능에 영향을 주거나 workaround가 있으며 발생 가능성이 있다.
- `Low`: 기능 영향이 작고 발생 가능성이 낮다.

같은 위치의 같은 문제는 하나로 합치고 가장 구체적인 설명과 높은 심각도를 유지한다. 같은 위치의 다른 문제와 같은 문제의 다른 위치는 각각 보존한다. 메인 에이전트는 통합 보고서를 직접 검토하고 수정 여부를 판단한다.

- `Critical`과 `High` finding은 완료 전에 해결한다.
- `Medium` finding은 해결하거나 연기 사유, 영향과 후속 티켓을 기록한다.
- `Low` finding은 기능과 안전에 영향이 없으면 선택적으로 backlog에 남길 수 있다.

기본 검수 흐름은 관점이 분리된 통합 review 1회와 수정 뒤 affected scope만 보는 targeted re-review 1회다. 잔여 Critical/High, 새 직접 근거 또는 안전 경계 변경이 있을 때만 추가 re-review를 연다. 같은 전체 범위를 근거 없이 반복 검수하지 않는다. 추가 Medium이 나오면 메인 에이전트가 현재 티켓에서 해결할지 영향·연기 사유·후속 티켓으로 분리할지 기록한다.

## 완료와 최종 보고

메인 에이전트는 승인된 결과를 통합하고 충돌과 누락을 확인한 뒤 전체 완료 여부를 최종 판단한다. 통합은 변경 파일 검수, 관련 테스트, 전체 검증, 최종 diff 검토, 명시적 stage와 commit 순서로 수행한다. 전체 검증은 변경 범위에 맞는 check 스크립트를 실제로 실행하고 결과를 인용한다: 로직·유닛·seam은 `npm run check`, F1/F2 UI·성능 변경은 `npm run check:f1` 또는 `check:f2`, 네트워크 차단·마이그레이션 경계는 `npm run verify:network-off`·`verify:migrations`, compose/PR 통합은 `npm run check:pr`. 가능한 한 티켓 하나를 커밋 하나로 마감하고 clean worktree를 확인한 뒤 다음 frontier를 같은 세션에서 계속할 수 있다. 사용자에게는 완료된 내용, 검증 결과, 남은 위험 또는 후속 작업을 하나의 일관된 최종 응답으로 보고한다.
