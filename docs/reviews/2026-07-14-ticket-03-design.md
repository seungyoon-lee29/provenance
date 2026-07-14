# 티켓 03 설계 검수 보고서

**Target**: `.scratch/financial-terminal/issues/03-design-data-identity-modules.md`와 관련 도메인 문서
**Reviewers**: architecture, security·data rights, performance·operations
**Date**: 2026-07-14

## Consolidated findings

### High

1. **Cold-cache 갱신 경로 누락** — cache miss를 실제 `no_data`로 오인하거나 initial이 외부 I/O를 기다릴 수 있었다. 패널 `pending` 상태와 독립적인 시장 refresh·stale revalidation을 [티켓 03](../../.scratch/financial-terminal/issues/03-design-data-identity-modules.md#answer)에 추가했다.
2. **Feed·venue provenance 부족** — 같은 provider의 IEX와 SIP처럼 권리와 지연이 다른 feed를 구분할 수 없었다. `available`에 provider/feed/venue와 기준·수신 시각을 필수 provenance로 정했다.
3. **AuthorizedTransport confused deputy 위험** — 범용 transport라면 adapter가 인증정보를 임의 origin으로 전송할 수 있었다. Viewer Context, 연결, 환경, capability와 allowlisted route에 묶고 임의 인증 header와 cross-origin redirect를 금지했다.
4. **Provider Connection IDOR 위험** — 명령의 Viewer Context 요구와 소유권 판정 위치가 불명확했다. 모든 명령이 Viewer Context를 받고 User Workspace를 내부 파생하며 소유권과 capability를 다시 검사하도록 정했다.
5. **외부 AI 처리 권리 축 누락** — 개인 표시권만으로 Gemini 전송과 파생물 생성을 허용할 위험이 있었다. [License Scope](../../CONTEXT.md#language)에 보존, 외부 모델 전송·처리와 파생물 생성 목적을 추가했다.

### Medium

1. **협업 seam의 가시성 불명확** — EvidenceResolver와 ProviderAuthorization을 소유 module의 server-only collaboration interface로 명시하고 presentation import를 금지했다.
2. **TerminalView update 수명주기 누락** — architecture와 performance reviewer의 같은 finding을 하나로 합쳤다. panel key, request revision, 독립 순서, merge·dedupe·completion·retry, 교체와 취소 책임을 TerminalView에 넣었다.
3. **Worker의 신뢰된 Viewer Context 경로 누락** — 공개 worker는 FinancialInformation 내부로 두고, 사용자별 작업은 Identity가 재해석하는 만료 가능한 JobContextReference만 queue에 저장하도록 정했다.
4. **Stale fallback 장애 정보가 비정형** — failed와 stale available이 같은 Provider Degradation 구조를 사용하도록 정했다.
5. **Feed별 cache validity 경계 누락** — soft/hard expiry와 stale-if-error를 provider/feed의 공표 주기, 계약과 rate limit에 따라 정하고 동일 cache-fill을 합치도록 했다.
6. **Guest·user 전환 수명주기 누락** — Viewer Context를 불변 인증 epoch에 묶고 로그인·로그아웃·workspace 전환 시 기존 stream을 폐기하며 emit 전에 권한을 재검사하도록 했다.

### Low

1. **Identity interface 설명 모순** — 수정 후 재검수에서 presentation `resolve(sessionProof)`와 server-only `resolveJob(reference)`가 모두 Viewer Context를 생성한다는 설명이 충돌했다. 두 interface facet의 caller와 가시성을 분리해 명시했다.

## Severity summary

| Dimension | High | Medium | Low | Note |
| --- | ---: | ---: | ---: | --- |
| Security·data rights | 3 | 1 | 0 | 4 unique |
| Performance·operations | 2 | 2 | 0 | update lifecycle 1건은 architecture와 공유 |
| Architecture | 0 | 2 | 1 | update lifecycle 1건은 performance와 공유 |
| **Unique total** | **5** | **6** | **1** | **12 resolved** |

## Residual risks

구체적인 p95 성능 예산, cache hit ratio, worker 포화, 재연결 폭주, AES-GCM nonce·AAD·키 회전, Evidence Reference의 만료·audience binding과 장애 주입 검증은 티켓 05에서 테스트 seam과 합격 기준으로 확정한다.
