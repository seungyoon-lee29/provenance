# F11 release integration — 진행 (ticket 20)

> ⚠️ **SUPERSEDED — 이 문서의 "완료" 는 현재 코드에 대한 주장이 아니다 (2026-07-26 표기).**
> 여기서 완료로 기록한 synthetic paper 스크린샷 시나리오 은(는) 2026-07-22 피벗의 Stage 1/2 컷에서 **삭제됐다.**
> 작성 시점에는 참이었고 기록으로서 유효하지만, **현재 능력의 근거로 인용하지 말 것.**
> 현행 범위는 [피벗 메모](../../../docs/notes/2026-07-22-pivot-backtest-strategy-engine.md)와
> [stage2-cleanup.md](./stage2-cleanup.md)가 정본이다.

Owner: claude-main. 사용자 스코프 결정(2026-07-19): **패키징+문서+매니페스트**(network-off 검증 가능분) 자율 구현, Docker 드릴·실데이터 스크린샷·k6 부하는 ready-for-human. F11은 두 guest-public 스크린샷이 실제 공개 정본 데이터(USD 0 예산·공급자 보류)를 요구해 자율 완전 resolve 불가 → Status claimed 유지.

## 자율 구현 완료 (전부 network-off 검증)

- **릴리스 패키징**: `scripts/release/manifest.ts`(순수 allowlist+secret 패턴 분류·fail-closed 카테고리) + `scripts/package-release.ts`(git ls-files→분류→per-file SHA-256+aggregate→secret scan[binary skip]→manifest.json+zip). `.scratch/`·`.env*`(example 제외)·`.secrets/`·`.git/`·build/cache 제외. `npm run package:release`. tests: `release-manifest`(5)·`release-zip`(1, unpack==manifest·재해시 무결성).
- **릴리스 문서 6종**: `docs/release/{setup,architecture,rights,privacy,backup,release}.md`. `scripts/check-release-docs.ts`(markdown 상대링크 존재 + `npm run` 스크립트 stale-contract 검사) + `npm run check:release-docs`. tests: `release-docs`(2, 링크 0 broken·6문서 존재).
- **스크린샷 provenance/rights 매니페스트**: `tests/release/screenshot-manifest.json`(4장, synthetic=internal_test_only·public=ready-for-human, secret/PII 제외 선언) + synthetic `paper-workspace.png` 실캡처(`tests/browser/paper-workspace.spec.ts`, 1366×604 desktop, SYNTHETIC 마커 포함). tests: `screenshot-manifest`(4).
- **릴리스 posture**: `tests/release/release-readiness.test.ts`(3, .env.example에서 RUN_*_CONTRACT 전부 false·ENABLE_LIVE_TRADING false·free_only·credential 값 공란 = 정직한 not_run/disabled).

검증: `npm run check` 1,222 tests / 105 files green. `package:release` 359 파일(source 310·docs 30·config 11·docker 3·migration 3·lockfile 2), zip==manifest·forbidden 0. `check:release-docs` 24문서 0 problem.

## Ready-for-human 게이트 (환경/외부 계약)

1. **production stack 드릴**: `npm run compose:verify`(docker compose up --build --wait, migration-smoke, network-off) — Docker daemon 필요. compose.yaml/Dockerfile/verify 스크립트는 F0에서 준비됨.
2. **backup/restore/deletion-suppression 드릴**: 복원 스택에서 erasure fence 재생성 0 확인(모듈 레벨은 테스트로 증명됨). docs/release/backup.md.
3. **§11.3 5분 stress/load**: 부하 도구(k6) 미vendored. 무료 외부 API에는 load 미실행 규약.
4. **두 guest-public 스크린샷**: `guest-desktop-public.png`·`guest-mobile-public.png` — 허용된 실제 공개 정본 데이터 필요(USD 0·공급자 보류). spec은 guest-shell.spec.ts, 매니페스트에 ready-for-human 기록.

## 진행 로그

- 2026-07-19: claim. 사용자 스코프(패키징+문서+매니페스트) 확정. B1 패키징·B2 문서·B3 스크린샷/매니페스트/posture 구현. check 1,222/105 green. ready-for-human 4게이트 기록, Status claimed.
