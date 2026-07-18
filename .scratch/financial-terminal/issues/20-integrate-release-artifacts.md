# 20 - F11 release integration·산출물 완성

Type: implementation
Status: open
Triage: ready-for-agent
Depends on: 14, 16, 18, 19
Blocked by: 19
Owner: unclaimed
Claimed at: -
Last heartbeat: -

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
