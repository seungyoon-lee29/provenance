# 41 - MCP read-only 카탈로그 표면

Type: implementation
Status: ready
Triage: ready-for-agent
Depends on: 13, 33
Blocked by: None
Owner: unassigned
Claimed at: -
Last heartbeat: -

> **v2 (2026-07-25)** — pivot(07-22)·Stage 1~2c·T8/T9 이후 재점검 반영.
> v1 대비 정정: ① Depends on 36(로그인 터미널, Stage 3 삭제 예정) 제거 ② **컨텍스트 모델
> 결정을 1급 미결로 명문화**(웹 세션 게이팅 서술이 Stage 3와 충돌) ③ 카탈로그 인벤토리에
> pivot 이후 1급 표면(백테스트 리포트·paper 조회) 추가 + read/compute/write 3분류
> ④ CLI와 "한 카탈로그, 두 표면" 관계 명시 ⑤ MCP SDK 의존성 결정 지시
> ⑥ outcome 전달 원칙을 BacktestOutcome류로 확장. v1 원문은 하단 보존.

## Context (v2)

이 프로젝트의 차별점은 coverage-typed 정직성이다 — `InformationOutcome`(available/unavailable/
failed + license scope + freshness)에 더해, pivot 이후에는 **백테스트 리포트의 coverage-typed
성과·비용 공시**(T8/T9: TWR/XIRR/MDD/승률/체결신뢰도 + gross-vs-net/tax drag, 전부
unavailable+reason 규율)가 같은 축에 있다. 값이 없을 때 그 이유를 구조화해서 주는 도구는
없다 — 이 표면이 없으면 설계의 핵심이 사람 눈에만 보인다(v1 논거 유지).

선례(tossinvest-cli catalog — 상시 툴 3개 고정, 개별 스키마는 필요할 때만)는 v1 그대로 유효.

## 착수 전 결정 필요 (v2 신규)

1. **컨텍스트 모델**: v1의 수용 기준은 웹 세션(게스트/owner 인증) 어휘였다 — Stage 3(웹·인증
   컷) 이후에는 존재하지 않는 표면이다. MCP는 로컬 stdio 서버이므로 **single_owner env 기반
   로컬 컨텍스트**(웹 세션 아님)로 갈 것을 권장하되, Stage 3 전에 착수한다면 어느 모델로
   조립하는지 착수 선언에 기록한다. 어느 쪽이든 어댑터의 personal scope guard(viewer-context
   타입 기반 2차 방어)는 그대로 유효하게 유지한다.
2. **의존성**: stdio MCP 서버 구현체 — `@modelcontextprotocol/sdk` 도입 또는 직접 JSON-RPC
   구현 중 택일해 기록한다(이 저장소는 의존성 추가에 보수적 — 도입 시 사유를 남긴다).
3. **CLI와의 관계**: 오퍼레이션 카탈로그는 **하나**이고 CLI(`--json` 동일 envelope, pivot
   메모)와 MCP가 같은 정의를 소비하는 두 표면이다. 카탈로그 정의의 소유는 이 티켓이다.

## Owned scope

- MCP stdio 서버 진입점 + 오퍼레이션 카탈로그(정의는 CLI와 공유 가능한 형태)
- 기존 module port **재사용만** — 새 데이터 경로·새 정규화를 만들지 않는다
- `tests/`

## Acceptance

- stdio JSON-RPC MCP 서버. 상시 노출 툴은 **정확히 3개**:
  `list_operations` / `describe_operation` / `call_operation`.
- 오퍼레이션은 **read / compute / write 3분류**를 갖는다:
  - **read**: 시장 데이터 outcome 조회, paper 계정/원장 조회.
    (정정 2026-07-25 재검증: v2 초판의 "백테스트 리포트 조회"는 현재 리포트 영속이 없어
    read로 성립하지 않는다 — 백테스트 결과는 compute 호출의 인라인 반환이며, 조회형
    리포트는 영속이 생길 때만 추가한다. 리포트 영속 도입은 이 티켓 스코프가 아니다.)
  - **compute**: **백테스트 실행** — 내구 상태 mutation 0(인메모리 결정론 실행)이지만 조회가
    아니므로 별도 분류로 명시하고 카탈로그에 포함한다.
  - **write**(주문·설정 변경·erasure)는 카탈로그에 포함하지 않는다 — **티켓 40의 confirm
    token이 선행되기 전에는 write를 논의하지 않는다**(v1 원칙 유지).
- 응답은 값이 아니라 outcome 타입을 **그대로** 전달한다 — `InformationOutcome`뿐 아니라
  `BacktestOutcome`(refusal reason)·coverage-typed 지표(unavailable+reason)도 평탄화하지
  않는다. `unavailable`의 사유와 freshness·as-of가 에이전트에 도달해야 한다.
- 결정된 컨텍스트 모델을 우회하지 않는다 — `personal` 데이터는 owner 컨텍스트 없이 노출되지
  않고, 어댑터의 scope guard가 2차 방어로 남는다.
- 새 network egress 목적지를 만들지 않는다. no-redistribution 불변식과 destination allowlist 유지.
- 크리덴셜이 없으면 해당 오퍼레이션이 `api_required` outcome을 반환하고, 서버는 계속 뜬다.

## Residual (미리 기록)

- MCP 표면이 생기면 릴리스 패키징 규칙에 이 진입점의 분류가 필요하다 — 릴리스 체계 자체가
  Stage 3 재정의 대상이므로 그때 함께.
- SKILL.md(에이전트 온보딩 문서, pivot 메모 ①②)는 T10 본 티켓 몫.

---

## v1 (2026-07-21, superseded — 이력 보존)

Depends on: 13, 33, 36

### Context

이 프로젝트의 유일한 진짜 차별점은 `InformationOutcome`(available/unavailable/failed +
license scope + freshness)이다. 그런데 지금 그 계약을 소비할 수 있는 건 브라우저뿐이다.

에이전트에게 값을 주는 도구는 흔하다. **값이 없을 때 그 이유를 구조화해서 주는 도구는 없다.**
`api_required`와 `license_restricted`와 `no_data`를 구분해서 받는 에이전트는 "모르겠다"와
"볼 권리가 없다"와 "그런 데이터가 없다"를 구분해 행동할 수 있다. 이 표면이 없으면 설계의
핵심이 사람 눈에만 보인다.

선례: `tossinvest-cli` 의 catalog 방식 — 오퍼레이션이 40개든 100개든 상시 컨텍스트에 상주하는
툴 스키마를 **3개로 고정**한다(`list_operations` / `describe_operation` / `call_operation`).
개별 오퍼레이션 스키마는 필요할 때만 꺼낸다.

### Owned scope

- MCP stdio 서버 진입점 + 오퍼레이션 카탈로그
- 기존 module port **재사용만** — 새 데이터 경로·새 정규화를 만들지 않는다
- `tests/`

### Acceptance

- stdio JSON-RPC MCP 서버. 상시 노출 툴은 **정확히 3개**:
  `list_operations` / `describe_operation` / `call_operation`.
- **read-only만.** 주문·설정 변경·erasure 등 mutation 오퍼레이션은 카탈로그에 포함하지 않는다.
  (티켓 40의 confirm token이 선행되기 전에는 write를 논의하지 않는다.)
- 응답은 값이 아니라 `InformationOutcome`을 **그대로** 전달한다. `unavailable`의 사유와
  freshness·as-of가 에이전트에 도달해야 한다. 에이전트 편의를 위해 outcome을 값으로 평탄화하지 않는다.
- viewer-context 게이팅을 우회하지 않는다. 게스트 컨텍스트로 실행되면 `public` scope만 나오고,
  `personal` 데이터는 owner 인증 없이 노출되지 않는다 — 어댑터의 scope guard가 2차 방어로 남는다.
- 새 network egress 목적지를 만들지 않는다. no-redistribution 불변식과 destination allowlist 유지.
- 크리덴셜이 없으면 해당 오퍼레이션이 `api_required` outcome을 반환하고, 서버는 계속 뜬다.

### Residual (미리 기록)

- MCP 표면이 생기면 `.scratch/`·릴리스 패키징 규칙에 이 진입점의 분류가 필요하다.
