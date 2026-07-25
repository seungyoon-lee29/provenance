# 20 - F11 release integration·산출물 완성

Type: implementation
Status: claimed
Triage: ready-for-human
Depends on: 14, 16, 18, 19
Blocked by: None
Owner: claude-main
Claimed at: 2026-07-19
Last heartbeat: 2026-07-19 (compose:verify 드릴 통과·이식성 회귀 수정)

> ⚠️ **보류 (2026-07-25, pivot 재점검)** — 잔여 ready-for-human 게이트(§11.3 k6 load·guest
> 실데이터 스크린샷)를 **집행하지 말 것**. 이 게이트들은 pre-pivot 웹 릴리스 체계(ZIP·웹
> 스크린샷·웹 성능 예산)의 것이고, pivot이 릴리스 체계 자체를 Stage 3에서 재정의하기로 했다
> (pivot §"Stage 3": package-release/manifest/check-release-docs "npm publish 체제로 재정의할지
> 삭제할지 이때 결정"). Stage 3 뒤 살아남는 게이트만 새 릴리스 티켓으로 승계한다.
> 완료된 부분(패키징 인프라·문서 체커·compose:verify 드릴)은 이력으로 유효.

## Objective

완성된 module seam을 black-box로 통합해 browser·접근성·성능·부하, Docker, secret-free ZIP, 운영 문서와 허용된 실데이터 screenshot까지 MVP release gate를 통과한다.

## Owned scope

- `tests/release/**`, Playwright/k6/performance/fault matrix와 release manifest.
- Docker production-like image/compose lock, packaging script, setup/architecture/rights/privacy/backup/release 문서와 screenshot artifact.
- shared public type/composition/migration/index/spec 변경은 F0/main owner가 통합하며 F11 implementer는 변경 요청만 낸다.

## Requirements

- F0~F10의 public behavior를 실제 Next server/worker/PostgreSQL/Redis/Mailpit에서 조합한다.
- PR-fast/integration/browser와 nightly/release runner, fixed provider/clock/calendar와 sample protocol을 고정한다.
- non-root production image, health/readiness, migration/rollback, backup/restore/deletion drill과 same-region 운영 가정을 문서화한다.
- release ZIP allowlist/SHA-256/secret exclusion과 clean directory unpack→documented command→healthcheck를 검증한다.
- 네 screenshot과 License Scope/provenance manifest를 만들고 synthetic, secret과 개인 account detail을 제외한다.

## Interface contract

- 새 public interface를 만들지 않고 `UF-*`, `WS-*`, `SEC-*`, `AT-01~12`를 기존 seam을 통해 검증한다.
- provider/OAuth/email/broker capability는 opt-in 결과를 `not_run/api_required | configured_unverified | unsupported | license_restricted`로 정직하게 기록한다.
- 실제 hosting/domain/운영 deploy와 Live Trading은 호출하지 않는다.

## Acceptance criteria

- 전체 typecheck/lint/unit/integration/browser/fault/property가 통과하고 nominal/stress에서 §11 p95, event loss/duplicate/revision reversal 0을 만족한다.
- desktop/mobile browser에서 guest, chart, identity/layout, AI, alert, Actual, Internal/Broker Paper와 Broker Sync 핵심 flow를 직접 조작한다.
- fresh Docker start, migration/reapply/rollback, worker, healthcheck와 backup restore deletion suppression이 통과한다.
- ZIP에 tracked source/lockfile/Docker/migration/docs/manifest만 있고 `.git`, `.env*`(example 제외), `.secrets`, cache/build/raw data/secret이 없다.
- `guest-desktop-public.png`, `guest-mobile-public.png`, `paper-workspace.png`, `explicit-unavailable.png`와 provenance/rights manifest가 요구 장면을 증명한다.
- Markdown link, stale-contract, staged allowlist, `git diff --cached --check`, secret scan과 clean worktree가 통과한다.

## Out of scope

- cloud account 생성, domain 구매, 운영 배포, 유료 provider 계약과 Live Trading.
- network-off scripted provider가 release performance 정본이다. 두 guest public screenshot만 허용된 실제 공개 정본 contract를 별도 evidence로 요구한다.

## Traceability

- [승인 spec](../spec.md) 모든 `UF-*`, `WS-*`, `SEC-*`, `AT-01~12`, §11~16, F11.

## Progress (release infrastructure — autonomous slice)

사용자 스코프 결정(2026-07-19): 패키징+문서+매니페스트(network-off 검증 가능분)를 자율 구현하고, Docker 드릴·실데이터 스크린샷·k6 부하는 ready-for-human으로 기록. F11은 두 guest-public 스크린샷이 허용된 실제 공개 정본 데이터(USD 0 예산·공급자 보류)를 요구해 자율로 완전 resolve 불가 → Status claimed.

### 구현·검증 완료 (전부 network-off)

- **릴리스 ZIP allowlist/SHA-256/secret-free**: `scripts/release/manifest.ts`(순수 분류·fail-closed 카테고리·secret 패턴은 pre-commit 훅과 동일) + `scripts/package-release.ts`(`npm run package:release`). tracked에서 `.scratch/`·`.env*`(example 제외)·`.secrets/`·`.git/`·build/cache 제외, per-file+aggregate SHA-256, binary는 secret-scan skip. `tests/release/release-manifest.test.ts`(5)·`release-zip.test.ts`(1: clean dir unpack==manifest·재해시 무결성·forbidden 0).
- **릴리스 문서 6종**: `docs/release/{setup,architecture,rights,privacy,backup,release}.md`. `scripts/check-release-docs.ts`(`npm run check:release-docs`: markdown 상대링크 존재 + npm-run stale-contract). `tests/release/release-docs.test.ts`(2).
- **스크린샷 provenance/rights 매니페스트**: `tests/release/screenshot-manifest.json`(4장·synthetic vs real·secret/PII 제외 선언) + synthetic `paper-workspace.png` 실캡처(`tests/browser/paper-workspace.spec.ts`, 1366×604, SYNTHETIC 마커). `tests/release/screenshot-manifest.test.ts`(4). `explicit-unavailable.png`는 F4에서 기존 캡처.
- **릴리스 posture**: `tests/release/release-readiness.test.ts`(3: `.env.example` RUN_*_CONTRACT 전부 false·ENABLE_LIVE_TRADING false·free_only·credential 값 공란 = not_run/disabled 정직 기록).

검증: `npm run check` 1,222 tests / 105 files green. `package:release` 359 파일(source 310·docs 30·config 11·docker 3·migration 3·lockfile 2)·zip==manifest·forbidden 0. `check:release-docs` 24문서 0 problem. `package.json`에 `package:release`·`check:release-docs` 스크립트 추가.

### Ready-for-human 게이트 (resolve 전 필요)

1. **production stack 드릴** — `npm run compose:verify`. **✅ 2026-07-19 실행·통과(4단계)**: pr-check(`npm run check` 이미지 내부)·전체 스택 up --wait(postgres/redis/app/worker Healthy·migrate Exited)·migration-smoke("migration smoke passed")·network-off("network-off harness passed") 전부 green, cleanup으로 컨테이너 0 잔여. **1차 실행이 이번 세션 산출물의 컨테이너 이식성 회귀 6건을 검출**(git·.env.example 부재 → release/isolation 테스트 실패) → fs 스캔 재작성 + git/env 부재 skip으로 수정(커밋 3da2ff4) 후 2차 통과. 드릴이 실제 회귀를 잡은 사례.
2. **backup/restore/deletion-suppression 드릴** — **아키텍처상 현재 불성립(2026-07-19 실사)**. 모듈 중 postgres 쿼리를 실행하는 것이 0개이고 postgres에는 `runtime_components` tracer 1행만 있다. F0가 의도적으로 "실행 가능한 첫 tracer"(티켓 09)로 설계돼 erasure fence를 포함한 모든 사용자 상태가 in-memory Map(`session-store.ts:53`). 그래서 `pg_dump→restore` 라운드트립은 tracer 1행만 왕복할 뿐 삭제 억제를 증명하지 못한다(theater). 불변식 자체는 모듈 레벨에서 증명됨(in-memory fence가 restore override). **스택 레벨 실증은 postgres 영속 계층이 있어야 가능하며 이는 F11의 black-box 통합 스코프 밖** — persistence 계층 도입 티켓([23 - Persistence seam](./23-persist-identity-erasure-spine.md), P1)이 선행돼야 한다. P1이 Identity·PersonalCache 이관 + 스택 backup/restore/deletion 드릴로 gate-2 패턴을 닫고, 돈 원장 영속(P2+) 완료 시 gate-2 완전 종결. docs/release/backup.md에 현 한계 주석 추가.
3. **§11.3 5분 stress/load** — 부하 도구 미vendored(사용자 결정 2026-07-19: ready-for-human 유지). k6 nominal/stress + spec §16의 **고정 runner**가 정본이며 hosted runner 수치는 정본이 아니다. 티켓 22 CI의 `nightly-perf` 레인이 `test:performance`를 참고 신호로 돌리되 정본이 아님을 주석에 명시. 모듈별 seam p95(§11.1/11.2)는 이미 통과. nominal/stress p95·event loss/duplicate/revision reversal 0은 정본 환경 필요.
4. **두 guest-public 스크린샷** — `guest-desktop-public.png`·`guest-mobile-public.png`, 허용된 실제 공개 정본 데이터 필요(USD 0·공급자 보류).

게이트 1(production stack 드릴) 통과. 재실사(2026-07-19) 결과 나머지 3개는 자율로 닫을 수 없음이 확정: 게이트 2(backup 드릴)는 **아키텍처상 불성립**(in-memory tracer, postgres 영속 부재 — persistence 계층은 F11 스코프 밖), 게이트 3(load)은 k6+고정 runner 정본 환경 필요(사용자: ready-for-human 유지), 게이트 4(실데이터 스크린샷)는 외부 공개 정본 계약(USD 0·공급자 보류). → Status claimed 유지. 게이트 2는 단순 "드릴 실행 대기"가 아니라 선행 persistence 티켓이 필요한 blocker로 재분류.

### Residual

- shared composition root에 broker-sync/actual erasure participant 실등록은 F0/main owner 통합(모듈 레벨 계약 증명 완료, F6~F10 공통 잔여).
- 배치 기록: `progress/f11-plan.md`.
