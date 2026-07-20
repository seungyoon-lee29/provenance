# 23 - Persistence seam (P1): Identity·PersonalCache 영속 + 삭제억제 드릴

Type: implementation
Status: resolved
Triage: done
Depends on: 09
Blocked by: None
Owner: claude-main
Claimed at: 2026-07-19
Last heartbeat: 2026-07-20 (사용자 스코프 결정: **3b-vii[erasure intent journal] → P2 이관**. 근거: durable PII 표면이 증명적으로 {Identity, PersonalCache}뿐(migration = identity_*·personal_cache_*·runtime_components[PII 없음]; Notification은 in-memory Map = 백업 잔류 0). F7이 지목한 물리 잔류는 **별도 journal이 아니라 이 티켓이 이미 명세한 "한 pg 트랜잭션(executor 주입)"으로 닫는다** — in-scope 두 store 모두 pg라 한 txn 공유 가능. journal은 "한 txn 공유 불가한 교차-모듈(P2 돈 클러스터)" participant에만 정당. erasure는 동기 요청/응답이라 크래시 시 호출자 재시도로 충분(autonomous recovery 불요, 현 AC에 없음). → 착수: 3b-vi[composition pg 게이트 + participant 배선 + **erase 원자화** + 재시작 통합 테스트] → 3b-viii[concurrency 하향분 + 드릴 claim 하향 + residual 문구] → codex 적대 재리뷰. 상세는 Gates 섹션. **[2026-07-20 갱신] 3b-vi 완료: codex 적대 재리뷰 PASS + compose:verify 전 레인 실 pg green, 커밋 체크포인트. 다음 = 3b-viii.** **[2026-07-20 RESOLVED] 3b-viii 완료(switchWorkspace revoke-escape 봉쇄·드릴 claim 하향, #2 claim-first는 accepted-residual), codex 3b-viii BLOCK(테스트 유효성)→결정론 테스트로 교체·오라클 실증, compose:verify 최종 green. 3b-vii→P2. Resolution 섹션 참조.**)

## Progress

- **슬라이스 1(완료)**: `PersonalCacheRepository<T>` async 포트 + `PersonalCacheStore` in-memory impl + 파라미터화 계약 스위트(양쪽 impl oracle) + fence 단조성 계약. 기존 F4 oracle async화. check green.
- **슬라이스 2(완료)**: `PgPersonalCache`(pg impl) + `db/migrations/0002_personal_cache`(fence·entry 테이블) + `withTransaction`(UoW seed, `src/platform/persistence/pg.ts`). **설계 결정 #1(TOCTOU) 실装**: write·erase 양쪽이 fence row `SELECT … FOR UPDATE`를 entry 조작 前에 잡아 직렬화 → race 시 entry가 fence 아래로 절대 안 남음. fence는 `GREATEST`로 monotonic. pg가 **in-memory와 동일 계약 스위트 통과** + 25회 race 동시성 테스트 통과(compose persistence-integration lane, 실 postgres). `verify-migrations.ts`를 N-migration 안전하게 일반화("down 후 재-up 성공"이 롤백 완전성 검증 — 하드코딩 테이블 체크 제거). compose:verify 5단계 green(잔여 컨테이너 0), CI PR-integration 자동 포함.
- **슬라이스 3a(완료, 커밋 b8d6e8c)**: 전-workspace cascade SEC-09 버그 수정 — `requestAdministrativeErasure`가 viewer workspace만 fence하던 걸 `IdentitySessionStore.workspacesOf` + account-scope 전-workspace 루프로 수정. red-first 회귀 테스트. 어느 영속 스코프든 필요한 독립 버그 픽스라 먼저 처리. check 1239 green.
- **슬라이스 3b-i(완료, 사용자 결정: full Identity 영속)**: async 리플 — `IdentitySessionStore` 공개 메서드 20개 sync→async(private 헬퍼는 in-memory라 sync 유지, pg 슬라이스에서 async화), `IdentityService`(resolve·revokeSession·beginReauthentication·requestAccountEmail·consumeAccountChallenge·requestAdministrativeErasure), `EmailChallengeService`(request·consume·#eligibility), `FederatedSignInService.consume` await, 합성 `identity-server.resolve`·`session-cookie.viewerFrom` async, 라우트 5개(revoke·connections GET/POST·email consume/request·workspace page) await. **매핑에 없던 표면 발견·처리**: `workspace-server.ts`(dev/test 레이아웃 shim)가 layout-service의 **의도적 sync `resolveViewer` seam**에 store.resolve를 넘겼음 → layout 리듀서까지 async 번짐 방지 위해 dev shim만 async화하고 dev 뷰어를 부트스트랩서 1회 eager 해석해 layout엔 캐시 sync 리졸버 주입(그 외 proof는 guest, store not-found와 동일). 소비 route 2개(workspace layout·reset) await. 테스트 6파일 await 전파(sonnet 위임, 기계적 215건; diff 검수 = await/async만 추가, assertion 불변). **동작 불변 검증**: `npm run check` green(typecheck 0에러·lint 0에러·1239 test green·seam 2종). 기존 테스트가 회귀 oracle.
- **슬라이스 3b-ii(완료)**: `IdentityStore` async 포트를 `session-store.ts`에 정의(20 메서드), 현 `IdentitySessionStore`가 `implements`(typecheck가 적합성 검증). consumer 3개(IdentityService·EmailChallengeService·FederatedSignInService)를 concrete class → `IdentityStore` 인터페이스 의존으로 재타입(pg drop-in 준비). 파라미터화 계약 스위트 `tests/persistence/identity-store-contract.ts`(10 케이스: issue/resolve·revoke current/all·erase 단조 fence+shred+closed·**restore-dominance**·email/federated 계정 정체성·tombstone·주입 clock 만료(absolute+idle)·switchWorkspace 회전·security revision). 만료 상수(`ABSOLUTE/IDLE_EXPIRY_MS`)를 export해 양쪽 impl이 동일 정책 공유. in-memory 대상 green. dead field `#securityEpoch` 제거(ponytail). `npm run check` 1249 green.
- **슬라이스 3b-iii-a(완료)**: pg accounts/sessions/fence 영속. migration `0003_identity`(identity_account·account_workspace·session·account_fence + `identity_fence_seq` + email/identity partial-unique). `PgIdentityStore`(`session-store.pg.ts`)가 in-memory와 **동일 계약 스위트 통과**(실 pg). **TOCTOU 봉쇄**: issueSession·erase·switchWorkspace가 계정 row `SELECT … FOR UPDATE` lock-first로 직렬화(설계결정#1) — 25회 race 테스트 통과. **divergence 0**: 만료·뷰어 로직을 순수 헬퍼 `sessionIsLive`·`buildWorkspaceViewer`로 추출해 양쪽 impl 공유(만료 상수도 export). fence 단조(`nextval`+`GREATEST`). 재시작-생존 테스트(새 store 인스턴스가 영속 세션 resolve, erase 후 fence 가시). `test:persistence-pg` 레인에 편입. **compose:verify green**(pr-check·migration-smoke 0003 up/down/재up·persistence-integration 12 tests·network-off). 미사용 dead `#loadAccount` 제거.
  - **슬라이스 3b-iii-b(완료)**: revoke/erasure receipt 영속. `IdentityStore` 포트에 `getReceipt`/`putReceipt` 추가(in-memory·pg 양쪽). migration `0004_identity_receipt`(`PRIMARY KEY(kind, proof_hash, idempotency_key)` 단독 + `payload_hash` 별도 컬럼 원자 비교, `outcome` jsonb, account FK 없음 — receipt는 resolve-前 아티팩트라 shred된 세션보다 오래 산다). **키 결정 확정**: 티켓 §46의 `UNIQUE(workspace,module,account,…)`는 일반 P2 receipt용 — identity receipt는 명령이 **자기 세션을 shred**해 재시도 시 proof를 계정으로 resolve할 수 없으므로 **proof_hash 기반 키**가 정당(코드/스키마 주석에 명시). `payload_hash`는 유니크 키 밖(설계결정#3 준수) → same-key/same-payload=replay, different-payload=side-effect-free conflict. `IdentityService`의 `#revokeReceipts`·`#erasureReceipts` Map을 포트로 이관, **공개 outcome 불변**(기존 service 단위 테스트가 회귀 oracle로 그대로 통과). 계약 스위트에 receipt 격리·first-writer-wins(이중 삽입 0) 케이스 2개, pg 테스트에 receipt 재시작-생존 케이스 추가. **compose:verify green**(0004 up/down/재up, pg identity 15 tests 실 postgres, network-off). **잔여**: erasure receipt를 erase 트랜잭션 안에 넣는 완전 원자화는 fence-first 뒤 별 커밋(현재) — fence는 이미 durable 커밋돼 크래시 시에도 삭제 강제는 유지, 정확한 outcome replay만 best-effort. 완전 원자는 교차-모듈 UoW(P2)에서 자연스럽게 닫힘. codex 재리뷰(3b-v) 대상.
  - **재시작 생존**: revoke/erasure 재시도가 저장된 receipt 반환(재실행 0).
  - **슬라이스 3b-iv(완료)**: backup 드릴 = **F11 gate-2 스택 증명**. `scripts/backup-drill.ts`가 실 postgres에 pg_dump/psql 왕복 2 시나리오를 돌린다. **(1) post-erase 라운드트립**: PgIdentityStore·PgPersonalCache로 seed(계정+2 workspace+세션+각 ws cache)→erase(fence+shred+전-ws cache fence 캐스케이드)→`pg_dump`→**깨끗한 신규 db(`fakebloomberg_restore`)에 복원**→`db:migrate`(no-op reconcile)→복원 db에서 fence row 존재·세션 guest·재-auth가 closed tombstone(재생성 억제)·양 ws cache size 0 assert. **(2) stale-backup 복원(FATAL 방어)**: 활성 계정 snapshot(erase 前)→erase 후 **live fence high-water 캡처**→stale dump를 live에 naive 복원(먼저 fence 사라짐을 assert로 명시)→**forward-only fence merge**(캡처한 identity/cache fence를 `GREATEST` 재적용 + `setval` 시퀀스 되감김 방지)→erase 지배 assert(isErased true·세션 guest·cache 억제)+새 erase가 복원된 high-water 넘어 전진. Dockerfile에 `postgresql17-client`(server 17 매칭), compose `backup-drill` verify 서비스, `verify:backup-drill` 스크립트, `verify-compose.sh` 배선. **compose:verify green 전 레인**(pr-check·migration-smoke·persistence-integration·**backup-drill**·network-off), 좀비 컨테이너 0. **설계결정#2(restore dominance) 실증 완료**.
  - **슬라이스 3b-vi(완료, 커밋 전 — 실 pg 검증 green)**: codex F1 blocker(러닝 스택 pg 미배선·participants=[]) 해소 + F7(SEC-09 물리 잔류) 봉쇄. **(1) 원자 erase seam**: `Executor`/`withExecutor` 포트(`platform/persistence/pg.ts`) + `IdentityStore.withUnitOfWork` + `erase`/`ErasureParticipant.erase`/`PersonalCacheRepository.eraseWorkspace`에 `tx?` 관통. `requestAdministrativeErasure`가 identity fence↑ + 전-workspace personal-cache shred를 **한 pg 트랜잭션**으로 커밋 — crash 시 전체 롤백(잔류 0), best-effort receipt/second bump은 txn 밖 유지(3b-iii-b 동작 보존). `bumpSecurityRevision`·`putReceipt`는 비-PII라 원자 경계 밖. red-first `erase-atomicity.pg.test.ts`(fault→롤백, commit→cascade 2 케이스). **(2) composition 배선**: `identity-assembly.ts`(pg/memory 백엔드 선택 + PersonalCache participant를 공유 pool 하나로 배선), `runtime-policy.ts` `IDENTITY_PERSISTENCE`(default memory·compose 앵커 postgres), `identity-server.ts`가 assembly 사용·`store` 타입 `IdentityStore`로 확장·participants 주입. `identity-composition.pg.test.ts`가 **배선된** 서비스로 재시작 생존 + 원자 캐스케이드 + 복원-억제 증명. **검증**: `npm run check` 1244 green + **compose:verify 전 레인 green**(persistence-integration 23 tests 실 pg — atomicity·composition 포함, migration-smoke, backup-drill SEC-09 gate-2 2종, network-off), 좀비 0. **Notification participant는 미배선(명시적 residual)**: in-memory Map = durable/backup 잔류 0이고 이 root에 미composed라 전체 그래프 조립은 비례성 밖.
  - **게이트**: 인증 spine + money/erasure 경로라 구현 후 **codex 재-적대리뷰** 필수.
  - **3b-vi codex 적대 재리뷰 완료(2026-07-20, 다른 계열 GPT) → 판정: PASS**. 8개 위험 축(원자성·크래시 롤백·데드락/락순서·txn 밖 read·receipt·composition 게이트·타입 확장·claim) 검증. secret 평문 0, 타입 확장 consumer 파손 0, composition 게이트(memory 기본·pg pool 격리)·compose 앵커 vitest 무영향 확인. 실질 finding 1건:
    - **[IMPORTANT, 수용·수정]** `workspacesOf`를 txn 밖에서 읽어 계정-스코프 erase 중 동시 `addWorkspace`가 새 ws의 cache 잔류를 남길 수 있는 SEC-09 벡터. 코드 대조: **addWorkspace 런타임 호출자 0(테스트만)이라 현재 도달 불가**하나, 내 3b-vi가 이전(fence commit 후 읽기)보다 창을 넓힌 게 맞음. → `workspacesOf(ref, tx?)`로 확장, erase가 계정 row 잠근 **txn 안**에서 읽도록 이동(엄격히 더 나음, 이전 순서 복원·초과). pg 다중-ws 계정 erase 테스트 추가(`identity-composition.pg.test.ts`), in-memory 다중-ws 서비스 오라클(`identity-service.test.ts`) 유지.
    - **[IMPORTANT, 부분수용]** atomicity 테스트가 서비스 층 우회(seam 직접). 단 `identity-composition.pg.test.ts`가 이미 서비스 경로(`requestAdministrativeErasure`)를 pg로 검증 — codex 저평가. 다중-ws pg 케이스 추가로 서비스-경로 커버리지 강화.
    - **[NIT]** claim 문구: SEC-09 종결은 in-scope 한정으로 정직하나, 위 순서 수정 전까진 pg도 완전치 않다는 지적 — 수정으로 해소.
    - **Residual(YAGNI)**: `addWorkspace`는 fence-미가드지만 런타임 호출자 부재. 향후 런타임 workspace-추가가 배선되면 **fenced 계정 add 거부**를 반드시 넣어야 계정-스코프 캐스케이드가 완전. Notification participant 미배선(in-memory·durable 잔류 0)도 residual.
    - 수정 후 재검증: `npm run check` 1244 green + **compose:verify 전 레인 green**(persistence-integration 24 tests 실 pg — 다중-ws 계정 erase 캐스케이드 +1, migration-smoke, backup-drill SEC-09 gate-2 2종, network-off), 좀비 0. **3b-vi = codex PASS + 실 pg 검증 완료(커밋 54c7618).**

- **슬라이스 3b-viii(codex 하향분 처리)**:
  - **[#1 switchWorkspace revoke-escape — 수정]** 위협 재분석: `switchWorkspace`·`revokeCurrent` 둘 다 동일 세션 proof(홀더 본인)를 요구 → 홀더가 자기 revoke를 self-race하는 것이고 교차-행위자 revoke(revokeAll)는 account epoch+account 잠금으로 이미 차단. 실 권한상승은 아니나 auth 경로 방어심화로 수정. `switchWorkspace`가 계정 잠금 **후** 세션 row를 `FOR UPDATE`로 재읽기(account→session 순 = erase와 동일, 데드락 없음) → 동시 revokeCurrent가 flip한 `revoked`를 관측해 revoke된 세션이 새 live 세션으로 회전 못 함.
  - **3b-viii codex 적대 재리뷰(2026-07-20, 다른 계열 GPT) → 판정 BLOCK(테스트 유효성만)**. 프로덕션 코드는 PASS 확인: 락 순서(account→session) erase와 호환 데드락 0, `preview`는 account_reference 획득에만·이후 전부 잠금 `session` 사용(stale-read 0), READ COMMITTED+FOR UPDATE 재읽기로 escape 창 0, 크로스액터(revokeAll/erase account-first) 무영향. **유일 finding(IMPORTANT)**: 25회 Promise.all race가 위험 인터리빙을 강제 못 해 FOR UPDATE 재읽기를 되돌려도 vacuously green 가능 → **결정론 테스트로 교체**: account 락 홀더로 switch를 preview 직후·locked 재읽기 직전에 park(`pg_locks NOT granted` 배리어)시키고 그 사이 revoke 커밋을 강제, `switched === undefined` 무조건 검증(vacuous 분기 없음). **오라클 유효성 실증**(일회용 pg): fixed=green, switchWorkspace revert(HEAD 구버전)=**red**(stale 세션 generation 2로 회전 escape 검출), 좀비 0.
  - **[#2 claim-first receipt — accepted-residual]** codex 자신이 CRITICAL→IMPORTANT 하향하며 "효과 멱등·무해"(revokeAll/erase 단조) 확인. `getReceipt→work→putReceipt` 비원자로 동시 동일-key 재시도가 이중 실행될 수 있으나 효과는 멱등이라 상태 오염 0. 무해한 race에 2-phase 예약 machinery는 비례성 밖(ponytail) → **accepted-residual**. strict "재실행 0"의 concurrency 보장은 P2 교차-모듈 UoW에서 receipt를 트랜잭션 안으로 넣을 때 자연 종결.
  - **[#3 드릴 claim 하향 — 수정]** `scripts/backup-drill.ts` 헤더에 스코프 정직 문구 추가: 드릴은 이관된 store(Identity+PersonalCache)에 대해 restore **절차**를 실증하며, JS 메모리 캡처 high-water를 재주입할 뿐 shipped operator 삭제 원장이 아님 → gate-2 property 실증이지 operator end-to-end 아님. 독립 삭제 원장+복원 도구 = P2.

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

- **코드 적대 재리뷰 완료(2026-07-20, codex 다른 계열, 6f867f9..362b07f 대상) → 판정: BLOCK, resolve 보류**. codex FATAL 4 + CRITICAL 3. 메인(claude)이 코드 대조·트리아지한 결과:
  - **[진짜 blocker, in-scope] F1 — 러닝 스택이 pg 미배선**: `identity-server.ts:86,95`가 `IdentitySessionStore`(in-memory)를 조립하고 `IdentityService`를 **participants 없이**(기본 `[]`) 생성 → 영속·erasure 캐스케이드가 앱에 도달 안 함. AC "러닝 스택엔 pg 배선"·"프로세스 재시작 생존 스택 통합" **미충족**. 지금까지 슬라이스(3b-i~iv)는 포트/impl/드릴만 만들었고 composition 배선은 미착수였음(회귀 아님, 미완). → **슬라이스 3b-vi**: composition을 pg pool로 조건 배선(network-off/unit은 in-memory 유지, `IdentitySingleton.store` 타입을 `IdentityStore`로 확장) + PersonalCache/Notification participant 배선 + **실 앱 표면 재시작 통합 테스트**.
  - **[진짜 gap, SEC-09] F7 — 크래시 시 participant PII 잔류**: erase가 identity fence를 durable 커밋한 뒤 participant cleanup·receipt 영속화 前 크래시 시, 재시도는 세션 shred라 `denied` 반환하고 participant 재실행 안 됨 → `personal_cache_entry` PII가 물리적으로 잔존(뷰어 발급은 불가해 도달불가지만 물리 삭제는 미완). fence-first는 identity fence만 원자 보장, participant는 비원자. → **슬라이스 3b-vii**: 재개 가능한 durable erasure intent journal(크래시 후 recovery가 participant 완료까지 재조정). *P2 교차-모듈 UoW와 겹침 — 이 티켓 P1에서 닫을지/claim 낮추고 P2 이관할지 사용자 판단 필요.*
  - **[진짜, but 일시적 read-race·durable hole 아님 — FATAL→IMPORTANT 하향]** F4/F5: `resolve()`·`switchWorkspace`가 세션 row 비락 읽기 → revoke/erase와의 read-committed 경합 시 방금 revoke된 세션이 1회 resolve/rotate될 수 있음. 단, 단조 fence가 durable 백스톱(erase 커밋 후 모든 후속 resolve는 guest). switchWorkspace의 stale `revoked=false` 회전은 좁지만 revoke-escape라 저비용 수정 가치 있음(세션 row `FOR UPDATE`). → **슬라이스 3b-viii**.
  - **[진짜, 효과는 멱등 — CRITICAL→IMPORTANT 하향]** F6: `getReceipt→work→putReceipt` 비원자 → 동시 동일-key 재시도 이중 실행 가능. revokeAll/erase는 효과 멱등(단조)이라 무해하나 strict "재실행 0" AC는 concurrency에서 미충족. claim-first 예약으로 폐쇄. → 3b-viii.
  - **[claim 무결성, 메인도 사전 flag]** F2/F3 — 드릴 restore-dominance가 자기충족적: `mergeFenceForward`가 JS 변수의 high-water를 재주입하고 독립 삭제 원장/복원 도구가 출하 안 됨. 드릴은 **절차**를 실증할 뿐 operator end-to-end 복원을 증명하지 않음. "gate-2 종결" claim은 과함 → "**gate-2 절차 실증, 독립 삭제 원장은 P2**"로 하향. F3(capture 3-read 비스냅샷)은 드릴 단일스레드라 미노출이나 절차로는 단일 txn 캡처가 옳음. → 3b-viii.
  - **[codex도 SAFE 확인]** migration SQL/PK/no-credential-plaintext/rollback(0004 down→re-up)·주입 clock·missed-await 0.

## Resolution (2026-07-20)

**Answer**: Identity(accounts·sessions·erasure fence·revoke/erasure receipt) + PersonalCache(entries·fence)를 postgres로 이관하고, 러닝 스택(`identity-server.ts`)이 `IDENTITY_PERSISTENCE=postgres`일 때 pg 백엔드 + PersonalCache erasure participant를 **공유 pool 하나**로 배선하도록 만들었다. SEC-09 물리 잔류(F7)는 별도 recovery journal이 아니라 **erase를 한 pg 트랜잭션으로 원자화**(identity deletion fence + 전-workspace personal-cache shred, executor 주입)해 닫았다 — durable PII 표면이 증명적으로 {Identity, PersonalCache}뿐(둘 다 pg)이라 한 txn으로 100% 커버, crash 시 전체 롤백으로 잔류 0. 트랜잭션 포트·스키마 컨벤션(append-only·단조 revision·idempotency 단독키+payload_hash·fence-first)은 P2 돈 티켓이 상속한다.

**Changed files**: `src/platform/persistence/pg.ts`(Executor·withExecutor), `src/modules/identity/{session-store.ts,session-store.pg.ts,identity-service.ts}`(withUnitOfWork·tx? 관통·원자 erase·switchWorkspace FOR UPDATE 재읽기), `src/modules/financial-information/data/{personal-cache.ts,personal-cache.pg.ts}`(eraseWorkspace tx?), `src/composition/{identity-assembly.ts(신규),identity-server.ts,runtime-policy.ts}`(pg 게이트·participant 배선), `compose.yaml`·`package.json`(레인·앵커), `scripts/backup-drill.ts`(claim 정직 문구), `tests/persistence/{erase-atomicity.pg.test.ts(신규),identity-composition.pg.test.ts(신규),identity-store.pg.test.ts}`. 커밋 54c7618(3b-vi) + 본 커밋(3b-viii).

**Validation**: `npm run check` 1244 green(typecheck·lint·test·seam 2종). **compose:verify 전 레인 실 pg green** — persistence-integration 25 tests(원자 erase 롤백/커밋, 다중-ws 계정 캐스케이드, 재시작 생존, TOCTOU race, revoke-escape 결정론), migration-smoke, **backup-drill SEC-09 gate-2 2종(post-erase·stale-restore dominance)**, network-off, pr-check. 좀비 0. 결정론 escape 테스트는 오라클 유효성 실증(fixed=green, revert=red).

**Review**: red-first TDD → codex 적대 재리뷰 2회(다른 계열 GPT). 3b-vi = **PASS**(workspacesOf txn-밖 TOCTOU 1건 IMPORTANT 수정). 3b-viii = **BLOCK(테스트 유효성만, 프로덕션 PASS)** → 결정론 테스트로 교체·실증. 상세는 Gates 섹션.

**Residual risks**: (1) 재개형 erasure intent journal = P2(동기 요청/응답이라 현 AC 불요, 교차-모듈 돈 클러스터에서 필요). (2) NotificationCenter participant 미배선(in-memory·durable/backup 잔류 0). (3) claim-first receipt 미구현(효과 멱등·무해, P2에서 receipt를 txn 안으로). (4) `addWorkspace` fence-미가드지만 런타임 호출자 0 — 향후 런타임 workspace-추가 배선 시 fenced 계정 add 거부 필수. (5) 돈 원장·outbox·event·vault ciphertext 영속 = P2. (6) 드릴은 gate-2 절차 실증이지 operator end-to-end 아님(독립 삭제 원장 P2).

## Out of scope

- 돈 원장(Actual·Accounting·Paper·BrokerBook)·outbox(Broker·Delivery)·event(BrokerSync)·delivery fact 영속 — **P2+ 클러스터별 티켓, money-path 풀 gate에서**. gate-2 완전 종결은 거기서.
- credential vault ciphertext 영속(P2), ephemeral/rate-limit 상태의 Redis 백킹(별도·선택), 다중 인스턴스/HA·read replica·pool 튜닝.

## Traceability

- 발단: [20 - F11 release integration](./20-integrate-release-artifacts.md) gate 2 재실사(in-memory tracer라 backup 드릴 불성립) → persistence 선행 티켓 필요로 재분류.
- [승인 spec](../spec.md) §8(append-only·한 account transaction 원자성), §12(durability·erasure SEC-09), §11(durability 예산). [09 - F0 기반](./09-build-foundation-contracts.md)의 pool·migration runner·vault 경계 위에 얹는다.
