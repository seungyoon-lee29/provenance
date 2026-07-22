# 41 - MCP read-only 카탈로그 표면

Type: implementation
Status: ready
Triage: ready-for-agent
Depends on: 13, 33, 36
Blocked by: None
Owner: unassigned
Claimed at: -
Last heartbeat: -

## Context

이 프로젝트의 유일한 진짜 차별점은 `InformationOutcome`(available/unavailable/failed +
license scope + freshness)이다. 그런데 지금 그 계약을 소비할 수 있는 건 브라우저뿐이다.

에이전트에게 값을 주는 도구는 흔하다. **값이 없을 때 그 이유를 구조화해서 주는 도구는 없다.**
`api_required`와 `license_restricted`와 `no_data`를 구분해서 받는 에이전트는 "모르겠다"와
"볼 권리가 없다"와 "그런 데이터가 없다"를 구분해 행동할 수 있다. 이 표면이 없으면 설계의
핵심이 사람 눈에만 보인다.

선례: `tossinvest-cli` 의 catalog 방식 — 오퍼레이션이 40개든 100개든 상시 컨텍스트에 상주하는
툴 스키마를 **3개로 고정**한다(`list_operations` / `describe_operation` / `call_operation`).
개별 오퍼레이션 스키마는 필요할 때만 꺼낸다.

## Owned scope

- MCP stdio 서버 진입점 + 오퍼레이션 카탈로그
- 기존 module port **재사용만** — 새 데이터 경로·새 정규화를 만들지 않는다
- `tests/`

## Acceptance

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

## Residual (미리 기록)

- MCP 표면이 생기면 `.scratch/`·릴리스 패키징 규칙에 이 진입점의 분류가 필요하다.
