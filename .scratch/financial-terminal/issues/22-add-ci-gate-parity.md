# 22 - CI 게이트 도입 (로컬 훅과 동일 게이트의 원격 강제)

Type: implementation
Status: claimed
Triage: ready-for-human
Depends on: 09
Blocked by: 초기 push (Claude tool-hook가 git push 차단 — 사람이 `ALLOW_PUSH=1 git push` 실행)
Owner: claude-main
Claimed at: 2026-07-19
Last heartbeat: 2026-07-19 (CI 구현·커밋 59557aa, private 원격 생성, push는 사람 대기)

## Objective

현재 품질 게이트는 전부 로컬 pre-commit 훅(whitespace·secret 스캔·typecheck·전체 vitest)이다. 훅을 거치지 않는 경로(다른 도구의 커밋, 훅 미설치 클론)가 생기면 뚫린다. 동일 게이트를 CI에서 두 번째 층으로 강제한다.

## Requirements

- CI 파이프라인이 pre-commit 훅과 **동일한 검사**를 실행한다: whitespace, secret 패턴 스캔, `.env.local`/`.secrets` 미추적 확인, typecheck, 전체 vitest, seams.
- 게이트 정의는 훅과 CI가 **한 소스를 공유**한다(스크립트 추출) — 두 벌 관리로 인한 드리프트 금지.
- CI에는 provider secret이 필요 없어야 한다(scripted lane만 실행, SEC-05 유지). secret을 CI 환경변수로 넣지 않는다.
- browser(Playwright)·perf 스펙은 별도 job으로 분리하고 필수/선택 여부를 명시한다(러너 비용 고려).
- push 차단 훅(ALLOW_PUSH=1)과의 관계를 문서화한다 — CI 도입이 push 정책을 약화하지 않는다.

## Needs-info (사용자 결정)

1. 원격 저장소를 만들 것인가, 어디에(GitHub/기타)? 현재 remote 없음.
2. CI 플랫폼(GitHub Actions 가정 가능 여부)과 러너 비용 한도.
3. browser/perf job을 CI 필수 게이트로 할지 선택 실행으로 할지.

## Out of scope

- 배포 파이프라인, 외부 provider contract 테스트(RUN_* 게이트), Live Trading 관련 어떤 경로도 포함하지 않는다.

## Traceability

- 발단: 2026-07-17 하네스 리뷰에서 "게이트 전부 로컬 훅 = CI 부재가 가장 약한 층" 지적. AGENTS.md 하한(훅 우회 금지)의 원격 집행 층.

## Answer (구현)

사용자 결정(2026-07-19): 원격 저장소 = GitHub, 플랫폼 = GitHub Actions. §11.3 부하는 별도(ready-for-human).

### 한 소스 공유 (드리프트 금지)

- **콘텐츠 게이트**(whitespace·credential 포맷 스캔·`.env.local`/`.secrets` 미추적)를 `scripts/gates/content-gates.sh` **한 곳**에만 정의하고 diff 범위를 인자로 받게 했다. 훅은 `--cached`(staged), CI는 `<base>...HEAD`(push/PR 범위)로 같은 스크립트를 호출한다. credential 패턴 리터럴은 자기 정규식과 매칭되지 않아(예: `sk-ant-` 뒤 `[`) 스크립트 자신을 커밋해도 스캔에 걸리지 않는다(기존 훅과 동일 성질).
- **빌드 게이트**는 단일 `npm run check`(typecheck·lint·test·seams)로, 훅과 CI가 같은 package.json 스크립트를 호출한다. 훅을 기존 `typecheck+test`에서 `npm run check`로 승격해 lint·seam까지 **완전 parity**를 만들었다(비용: 로컬 커밋에 lint+2 seam tsx 추가, test는 이미 전체 실행 중이라 한계비용 작음).

### CI 레인 (spec §16 매핑, `.github/workflows/ci.yml`)

- `PR-fast`(**필수**): content-gates 범위 스캔 + `npm run check`. `fetch-depth: 0`으로 범위 diff 히스토리 확보. push(main)+PR 모두.
- `PR-integration`(**필수**, PR/push): `npm run compose:verify` — pr-check·migration-smoke·network-off Docker 스택. 지난 세션 컨테이너 이식성 회귀를 잡은 레인.
- `PR-browser`(**선택**, `continue-on-error`): Playwright desktop/mobile(webServer 자동 기동). runner 비용 고려.
- `nightly-perf`(**선택**, schedule+manual): `test:performance`. **hosted runner는 spec의 '고정 runner' p95 정본이 아님**을 주석에 명시 — 참고 신호용. k6 nominal/stress는 여전히 미vendored(ticket 20 gate 3와 동일 잔여).

### 안전·정책

- **secret 0**: 어떤 job도 provider secret을 쓰지 않는다(scripted lane만, SEC-05). `permissions: contents: read` 최소권한. egress-off는 network-off 하네스가 증명(runner 방화벽 아님).
- **push 정책 불변**: `.husky/pre-push`의 기본 차단(`ALLOW_PUSH=1`)은 유지. CI는 완화가 아니라 **두 번째 층** — 훅을 우회한 커밋(다른 도구·미설치 클론)도 원격에서 같은 게이트에 걸린다. setup.md에 관계 문서화.

### 검증

- `content-gates.sh --cached`가 스테이징된 신규 파일(자기 자신 포함) 위에서 EXIT 0 — 자기매칭·비밀 없음 확인.
- `npm run check`: typecheck OK, lint 0 error, **1234 tests / 109 files pass**, seams 실행.
- `check:release-docs`: 30 docs / 0 problem(신규 setup.md 링크 전부 resolve).
- 원격 push 후 실제 Actions run green은 원격 생성·초기 push 뒤 관측(아래 Residual).

## Changed files

- `scripts/gates/content-gates.sh`(신규, 공유 콘텐츠 게이트), `.husky/pre-commit`(리팩터: 공유 스크립트 호출 + `npm run check` 승격), `.github/workflows/ci.yml`(신규), `docs/release/setup.md`(CI 게이트·ALLOW_PUSH 관계 문서화).

## Residual

- **초기 push는 사람이 실행** — Claude tool-hook(`block-dangerous-git.sh`)가 `git push`를 도구 레벨에서 전면 차단(ALLOW_PUSH과 무관). private 원격 `github.com/seungyoon-lee29/fakebloomberg` 생성·`origin` 배선·전체 히스토리 credential clean(root...HEAD content-gates EXIT 0)까지 완료. 사람이 `ALLOW_PUSH=1 git push -u origin main` 실행 → Actions 첫 run green 관측 시 resolve.
- 초기 push는 `github.event.before`가 all-zero라 content-gates가 root commit fallback으로 전체 히스토리 범위를 스캔(위에서 이미 로컬 검증). browser/nightly 레인은 `continue-on-error`라 실패해도 필수 게이트를 막지 않는다.
- 리포 visibility는 **private** 기본값. public 공개가 필요하면 `gh repo edit --visibility public` (외부 노출 결정이라 사람 판단).
