# 09 - F0 기반·공유 계약·vault 구축

Type: implementation
Status: claimed
Triage: ready-for-human
Depends on: 07, 08
Blocked by: Local Docker runtime unavailable on this Mac
Owner: /root
Claimed at: 2026-07-15T12:58:04+09:00
Last heartbeat: 2026-07-15T14:12:58+09:00

## Objective

Next.js TypeScript 모듈형 모놀리스, 별도 worker, PostgreSQL, Redis와 network-off test harness를 실행 가능한 첫 tracer로 만들고 이후 lane이 읽기 전용으로 사용할 공유 계약·vault·transport 경계를 고정한다.

## Owned scope

- package/lockfile, TypeScript·lint·test·Next 설정과 app/worker bootstrap.
- `src/shared/**`, `src/composition/**`, `src/platform/credential-vault/**`, generic `ProviderAuthorization/AuthorizedTransport` primitive, `db/migrations/**`, 모든 barrel/index.
- Docker/compose foundation, health/readiness와 `tests/harness/**`.
- 이 ticket이 끝난 뒤에도 위 shared path는 F0/main owner만 수정하고 다른 lane은 변경 요청만 낸다.

## Requirements

- `ViewerContext`, `InformationOutcome<T>`, `MutationControl`, epoch/version, branded reference와 §6 public/server-only interface shape를 선언한다.
- CredentialVault는 AES-256-GCM envelope, purpose AAD, active/previous version, rewrap와 plaintext fallback 금지를 구현한다.
- generic AuthorizedTransport는 viewer/connection/provider/environment/capability/generation/fence/route/expiry에 bind하고 임의 origin·auth header·redirect를 막는다.
- `free_only`, canonical origin, environment, local credential mode와 synthetic/paid/live startup policy를 fail closed한다.
- queue에는 raw Provider Credential, account identifier, Viewer Context 또는 provider payload를 넣지 않는다.

## Interface contract

- feature module은 shared public type과 injected port만 import하며 repository, provider SDK와 composition root를 presentation에 노출하지 않는다.
- F3은 CredentialVault와 ProviderAuthorization primitive 위에 ProviderConnections core를 구현한다. F4/F9/F10은 각각 data/AI, paper, read route registry만 소유한다.
- migration, public type, composition root와 index 변경은 후속 ticket에서도 main owner가 통합한다.

## Acceptance criteria

- 문서화한 한 명령으로 app, worker, PostgreSQL과 Redis가 secret 없이 시작되고 health/readiness가 실제 process에서 통과한다.
- fresh DB migration apply, 재실행과 rollback smoke가 성공한다.
- typecheck, lint, public seam example, NIST/tamper/AAD/rotation vault suite와 transport SSRF/route/generation fence suite가 통과한다.
- PR harness는 localhost와 선언한 Docker network 밖 egress를 거절하며 외부 hostname 접근 fixture가 즉시 실패한다.
- paid adapter/route/schedule, Live submit capability/route와 production synthetic mode의 등록 수가 0이고 잘못된 설정은 startup 실패다.

## Out of scope

- guest UI, provider별 data adapter, 로그인, portfolio, order와 alert 동작.
- 실제 provider 호출, 외부 배포와 secret 검증.

## Traceability

- [승인 spec](../spec.md) §6, §7, §12.2, §13, F0, `SEC-03/04/05/10`, `AT-11`; ADR `A01~A04`, `CFG`.

## Progress

- app/worker bootstrap, PostgreSQL·Redis readiness, migration runner와 Docker internal-network compose tracer를 구현했다.
- shared public/server-only seam, strict queue envelope, AES-256-GCM CredentialVault·local keyring, authoritative ProviderAuthorization·pinned HTTPS transport를 구현했다.
- fail-closed runtime composition에 `free_only`, canonical origin, local/global credential, OAuth, delivery keyring과 email 정책을 적용했다.

## Validation checkpoint

- `npm run check`: typecheck, lint, 9 files/81 tests, public/server seam 통과.
- `npm run build`: production build와 route generation 통과. `npm audit --audit-level=high`: 취약점 0.
- 실제 Next process에서 `/`, `/api/health` 200과 의존성 미구성 `/api/ready` 503을 확인했고 readiness는 0.03초 이내에 fail closed했다.
- compose YAML 구조, internal-only PR check 배치, shell syntax와 secret/TypeScript escape scan을 확인했다.
- standards/spec 2축 review와 수정 범위 targeted re-review에서 Critical/High/Medium 잔여 0을 확인했다.

## Blocker

- 로컬에 `docker` CLI/runtime과 PostgreSQL·Redis 대체 runtime이 없어 `npm run check:pr`, 네 process readiness, fresh/reapply/rollback migration smoke와 Docker network-off 실제 실행은 아직 검증하지 못했다. 시스템 runtime 설치·실행 권한이 준비되면 이 합격 gate를 실행한 뒤 티켓을 resolve한다.
