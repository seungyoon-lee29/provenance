# 23 - Persistence seam (P1): Identity·PersonalCache 영속 + 삭제억제 드릴

Type: implementation
Status: claimed
Triage: ready-for-agent
Depends on: 09
Blocked by: None
Owner: claude-main
Claimed at: 2026-07-19
Last heartbeat: 2026-07-20 (슬라이스 3b-i[Identity async 리플, 동작 불변] 완료 — src 0에러, 1239 green; 다음 3b-ii[repo 포트])

## Progress

- **슬라이스 1(완료)**: `PersonalCacheRepository<T>` async 포트 + `PersonalCacheStore` in-memory impl + 파라미터화 계약 스위트(양쪽 impl oracle) + fence 단조성 계약. 기존 F4 oracle async화. check green.
- **슬라이스 2(완료)**: `PgPersonalCache`(pg impl) + `db/migrations/0002_personal_cache`(fence·entry 테이블) + `withTransaction`(UoW seed, `src/platform/persistence/pg.ts`). **설계 결정 #1(TOCTOU) 실装**: write·erase 양쪽이 fence row `SELECT … FOR UPDATE`를 entry 조작 前에 잡아 직렬화 → race 시 entry가 fence 아래로 절대 안 남음. fence는 `GREATEST`로 monotonic. pg가 **in-memory와 동일 계약 스위트 통과** + 25회 race 동시성 테스트 통과(compose persistence-integration lane, 실 postgres). `verify-migrations.ts`를 N-migration 안전하게 일반화("down 후 재-up 성공"이 롤백 완전성 검증 — 하드코딩 테이블 체크 제거). compose:verify 5단계 green(잔여 컨테이너 0), CI PR-integration 자동 포함.
- **슬라이스 3a(완료, 커밋 b8d6e8c)**: 전-workspace cascade SEC-09 버그 수정 — `requestAdministrativeErasure`가 viewer workspace만 fence하던 걸 `IdentitySessionStore.workspacesOf` + account-scope 전-workspace 루프로 수정. red-first 회귀 테스트. 어느 영속 스코프든 필요한 독립 버그 픽스라 먼저 처리. check 1239 green.
- **슬라이스 3b-i(완료, 사용자 결정: full Identity 영속)**: async 리플 — `IdentitySessionStore` 공개 메서드 20개 sync→async(private 헬퍼는 in-memory라 sync 유지, pg 슬라이스에서 async화), `IdentityService`(resolve·revokeSession·beginReauthentication·requestAccountEmail·consumeAccountChallenge·requestAdministrativeErasure), `EmailChallengeService`(request·consume·#eligibility), `FederatedSignInService.consume` await, 합성 `identity-server.resolve`·`session-cookie.viewerFrom` async, 라우트 5개(revoke·connections GET/POST·email consume/request·workspace page) await. **매핑에 없던 표면 발견·처리**: `workspace-server.ts`(dev/test 레이아웃 shim)가 layout-service의 **의도적 sync `resolveViewer` seam**에 store.resolve를 넘겼음 → layout 리듀서까지 async 번짐 방지 위해 dev shim만 async화하고 dev 뷰어를 부트스트랩서 1회 eager 해석해 layout엔 캐시 sync 리졸버 주입(그 외 proof는 guest, store not-found와 동일). 소비 route 2개(workspace layout·reset) await. 테스트 6파일 await 전파(sonnet 위임, 기계적 215건; diff 검수 = await/async만 추가, assertion 불변). **동작 불변 검증**: `npm run check` green(typecheck 0에러·lint 0에러·1239 test green·seam 2종). 기존 테스트가 회귀 oracle.
  - **3b-ii 포트+계약(다음)**: `IdentityAccountRepository` async 포트 + in-memory(현 로직) + pg 두 impl, 양쪽 파라미터화 contract suite(slice 1/2 패턴).
  - **pg + migration**: accounts·sessions·`account_fence`·revoke/erasure `receipt` 테이블. **idempotency = `UNIQUE(workspace,module,account,kind,idempotency_key)` 단독 + payload_hash 원자 비교**(hash를 유니크 키에 넣지 않음). fence-first는 slice 2 패턴(`FOR UPDATE` lock-first)으로 UoW 원자 erase(fence+shred+세션삭제+receipt+전-workspace cascade 한 트랜잭션).
  - **재시작 생존**: revoke/erasure 재시도가 저장된 receipt 반환(재실행 0).
  - **backup 드릴(gate-2 종결)**: compose 프로파일 — (1) post-erase 라운드트립, (2) stale-backup 복원 시 삭제 데이터 부활 0(fence restore-dominance). PersonalCache는 이미 pg라 드릴에 편입.
  - **게이트**: 인증 spine + money/erasure 경로라 구현 후 **codex 재-적대리뷰** 필수.

## Objective

현재 앱은 network-off in-memory tracer로, postgres에는 `runtime_components`·`schema_migrations`만 있고 모든 모듈 상태(erasure fence 포함)가 RAM에 있다(F11 gate 2 재실사, 2026-07-19). 이 티켓은 **persistence seam을 도입**한다: (1) 여러 repository write를 한 postgres 트랜잭션으로 묶는 Unit-of-work 포트와 스키마 컨벤션(append-only·단조 revision·idempotency·fence-first)을 확정하고, (2) **Identity(accounts·sessions·erasure fence) + PersonalCache(entries·fence)** 한 세트를 end-to-end로 postgres에 이관해, **스택 레벨 backup/restore/deletion-suppression 드릴(F11 gate 2)이 이 저장소들에 대해 실제로 성립**하게 만든다.

돈 원장·outbox·event(F6~F10)는 **이 티켓 범위 밖**이다(money/체결 경로 = 최상위 gate, P2+에서 클러스터별 별도 티켓). 이 티켓이 확정하는 트랜잭션 포트·스키마 컨벤션을 그 티켓들이 상속한다.

## Owned scope

- 신규 `src/platform/persistence/**`: Unit-of-work 트랜잭션 포트 + repository 베이스(append-only·revision·idempotency·fence 헬퍼). in-memory와 pg 두 구현.
- `src/modules/identity/session-store.ts`(accounts·sessions·`#erasedAccounts` fence) + `identity-service.ts`의 **내구 재시도 상태**(`#revokeReceipts`·`#erasureReceipts`)를 repository 포트에 의존하도록 리팩터 — **공개 동작 불변**, backing만 교체. `#reauth`·federated `#intents`는 단기 challenge라 ephemeral 유지(아래 설계 결정에서 명시).
- `src/modules/financial-information/data/personal-cache.ts`(entries + workspace 단위 fence) 동일 리팩터.
- 신규 migration(`db/migrations/000N_*`): identity/personal-cache/receipt 테이블 + fence 테이블.
- `tests/persistence/**`: 양쪽 impl에 도는 파라미터화 store-contract suite + pg 동시성/재시작 통합 테스트 + compose `backup-drill` 프로파일과 드릴 스크립트.
- 단일 main owner가 composition/`db`/migration을 통합한다(이 저장소는 별도 F0 owner가 없음 — F-레인 티켓의 "요청만" 문구는 적용 안 함). shared **spec** 변경만 별도 승인 경유.

## Requirements

- **Unit-of-work 트랜잭션 포트**: 범위 내 원자 연산(계정 생성·세션 발급, erase 시 fence 증가+shred+참여 store 정리+**계정 소유 모든 workspace의 cache fence 캐스케이드**, revoke/erasure receipt 기록)이 **한 pg 트랜잭션**으로 커밋된다. 부분 실패는 half-write를 남기지 않는다. store 메서드는 실행자(executor/tx)를 주입받는다.
- **동시성 봉쇄(명세 필수)**: fence-first는 그냥 두면 pg에서 TOCTOU다(READ COMMITTED 하에 writer가 fence=0 읽고, 동시 erase가 fence=1 커밋·shred하면 writer가 그 뒤 삽입). fence row를 `SELECT … FOR UPDATE`로 잠근 뒤 compare-and-write를 원자화하거나 SERIALIZABLE + **필수 재시도**로 닫는다. 어느 쪽인지 설계 결정에 확정하고 **동시 erase↔write 테스트**로 증명한다.
- **스키마 컨벤션(P2+가 상속)**:
  - append-only: `(scope, revision)` 유니크로 단조 revision·optimistic conflict/rejected 보존.
  - idempotency: **`UNIQUE(workspace, module, account, kind, idempotency_key)` 단독 제약**(payload hash는 포함하지 않음) + 별도 `payload_hash` 컬럼. 삽입 충돌 시 저장된 hash와 원자 비교 → 같으면 기존 receipt 반환, 다르면 **side-effect 없는 conflict**. (hash를 유니크 키에 넣으면 same-key/different-payload가 conflict가 아니라 이중 삽입·이중 실행이 된다 — 금지.)
  - fence: 단조 값 테이블, 모든 write가 fence 선검사(fence-first, SEC-09) 후 진행.
- **Identity 이관**: accounts·sessions·`erased_accounts`(단조 삭제 fence) + revoke/erasure **receipt**를 postgres로. session lookup은 fence로 가려지고, generation/authorization epoch·workspace switch·deletion fence 의미가 보존된다. **재시작 후 동일 revoke/erasure 재시도가 저장된 receipt를 찾아 재실행하지 않는다**(멱등성 재시작 생존).
- **PersonalCache 이관**: entries + workspace 단위 fence. soft/hard expiry는 **주입 앱 clock** 타임스탬프로 판정(SQL `now()` 금지 — 결정론). 계정 erase는 그 계정이 소유한 **모든 workspace**의 cache fence를 캐스케이드한다.
- **이관 안 한 store는 포트 뒤 in-memory 구현 유지**: 돈 원장·outbox·event 등은 이번엔 in-memory 그대로(같은 포트의 in-memory impl). 앱은 계속 뜨고 network-off CI는 green.
- **backup/restore/deletion 드릴**: compose `backup-drill` 프로파일이 두 시나리오를 실증한다.
  1. **post-erase 라운드트립**: seed→erase→`pg_dump`→clean db restore→migrate→(삭제 계정·복수 workspace cache 부재, fence row 존재, 재생성 억제).
  2. **stale-backup 복원(FATAL 방어)**: erase **이전** 스냅샷을 복원해도 삭제 데이터가 부활하지 않음 — fence가 restore를 dominate. 이를 위해 fence는 restore가 high-water 아래로 되돌릴 수 없어야 한다(설계 결정: fence를 forward-only 병합하거나, fence high-water보다 낮은 백업 복원을 거부). 드릴이 이 경로를 assert한다.
- **secret at rest 하한**: 어떤 테이블에도 credential 평문 컬럼 금지. (vault ciphertext 영속은 P2 — 이 티켓은 건드리지 않음.)

## Interface contract

- 새 공개 port: `persistence`의 `UnitOfWork`(typed repository 접근 + `withTransaction`). 모듈은 이 포트에 생성자 주입으로 의존한다.
- Identity·PersonalCache store는 **in-memory impl** 과 **pg impl** 두 구현을 갖는다. 둘 다 **동일한 파라미터화 store-contract suite**를 통과해야 한다 — "기존 단위 테스트=oracle"은 in-memory만 검증하므로, pg의 null/ordering/constraint/동시성 시맨틱이 조용히 갈라지는 걸 막는다(compose:verify가 잡았던 "로컬 통과·컨테이너 실패" 부류 방지). composition root가 러닝 스택엔 pg를, 단위 테스트엔 in-memory를 배선한다.
- 모듈의 **공개 outcome(receipt·conflict·rejected·fence 의미)은 변경 없음** — 기존 module 단위 테스트가 회귀 oracle로 그대로 통과해야 한다.
- 실제 hosting/Live Trading은 호출하지 않는다. 이관 대상은 Identity·PersonalCache로 한정한다.

## Acceptance criteria

- Identity(accounts·sessions·fence·revoke/erasure receipt)·PersonalCache 상태가 **실제 pg에 대해 프로세스 재시작을 넘어 생존**한다(스택 통합 테스트). 재시작 후 revoke/erasure 재시도가 저장된 receipt를 반환(재실행 0).
- 범위 내 원자 연산이 **한 pg 트랜잭션**으로 커밋된다 — 주입 실패점에서 half-write 0.
- **동시 erase↔write**에서 fence-first race가 봉쇄됨 — erase 커밋 뒤 write는 fence에 걸려 억제(TOCTOU 삽입 0).
- idempotency: same-key/same-payload=기존 receipt, **same-key/different-payload=side-effect 없는 conflict**(이중 삽입 0).
- 계정 erase가 그 계정 소유 **모든 workspace**의 cache를 억제한다(단일 viewer workspace만이 아님).
- SEC-09 fence 드릴 2종 통과(compose `backup-drill`): **(1) post-erase 라운드트립** 삭제 부재+fence 존재+재생성 억제, **(2) stale-backup 복원**에서 삭제 데이터 부활 0 — F11 gate 2의 스택 증명(이관된 store 한정).
- 기존 전체 단위 테스트 green(in-memory impl 행동 불변) **+ 동일 contract suite가 pg impl에서도 green**, `npm run check`·`compose:verify`(network-off 포함) green.
- pg 만료 경계가 주입 clock으로 결정론적(SQL `now()` 미사용).
- 어떤 테이블에도 secret 평문 없음, `git diff --cached --check`·secret scan·clean worktree 통과.

## Design decisions (red-first에 확정)

구현 첫 슬라이스에서 아래를 명시적으로 정하고 테스트로 고정한다(codex 적대 리뷰가 지목한 미명세 지점):

1. **격리수준 + fence-first race 봉쇄**: `SELECT … FOR UPDATE`(fence row 잠금)+compare-and-write 원자화 **또는** SERIALIZABLE+필수 재시도 중 택1. 동시 erase↔write 테스트로 증명.
2. **fence의 restore dominance**: stale-backup 복원이 삭제 데이터를 부활시키지 못하도록 fence를 forward-only 병합하거나 fence high-water 아래 백업 복원을 거부. 드릴 시나리오 2로 증명.
3. **idempotency 제약**: `UNIQUE(workspace, module, account, kind, idempotency_key)` 단독 + `payload_hash` 원자 비교(hash를 유니크 키에 넣지 않음).
4. **ephemeral 경계**: `#reauth`·federated `#intents`는 단기 challenge라 재시작 시 무효화가 정당 → ephemeral 유지(의도적 결정, 누락 아님). revoke/erasure receipt는 영속(멱등성).

## Gates (risk-proportional)

트랜잭션 포트·스키마 컨벤션은 P2+ 돈 티켓들이 상속하므로 **아키텍처 gate** 적용: red-first TDD → 포트/스키마 설계 리뷰 → **다른 계열(codex) 적대 리뷰** → 판정. 이관 자체는 공개 동작 불변이라 기존 module 테스트가 회귀 oracle.

- **설계 v1 적대 리뷰 완료(2026-07-19, codex 다른 계열)**: FATAL 2(stale-backup 복원·fence-first TOCTOU) + CRITICAL 3(idempotency 유니크 오명세·identity receipt 미영속·전 workspace 캐스케이드 누락) + IMPORTANT 2(pg 공유 contract suite·주입 clock). 7건 전부 위 Requirements/AC/Design decisions에 반영 → **설계 v2**. 구현 후 코드 대상 재-적대 리뷰는 별도.

## Out of scope

- 돈 원장(Actual·Accounting·Paper·BrokerBook)·outbox(Broker·Delivery)·event(BrokerSync)·delivery fact 영속 — **P2+ 클러스터별 티켓, money-path 풀 gate에서**. gate-2 완전 종결은 거기서.
- credential vault ciphertext 영속(P2), ephemeral/rate-limit 상태의 Redis 백킹(별도·선택), 다중 인스턴스/HA·read replica·pool 튜닝.

## Traceability

- 발단: [20 - F11 release integration](./20-integrate-release-artifacts.md) gate 2 재실사(in-memory tracer라 backup 드릴 불성립) → persistence 선행 티켓 필요로 재분류.
- [승인 spec](../spec.md) §8(append-only·한 account transaction 원자성), §12(durability·erasure SEC-09), §11(durability 예산). [09 - F0 기반](./09-build-foundation-contracts.md)의 pool·migration runner·vault 경계 위에 얹는다.
