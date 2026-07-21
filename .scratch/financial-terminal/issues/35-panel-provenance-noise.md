# 35 - 패널 provenance 노이즈 정리 (기본 숨김 + 토글)

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 10, 13
Blocked by: None
Owner: main
Claimed at: 2026-07-21T10:10:00Z
Last heartbeat: 2026-07-21T10:35:00Z

## Resolution (2026-07-21)

### Answer

① 프리젠터에 **한 줄 요약** 추가 — `출처 · 신선도 · 시각`. available일 때만 만든다(값 없는
outcome에 출처 줄을 지어내지 않는다). 일별 공표는 asOf가 자정 UTC라 날짜만, 장중 관측은 분까지
+ `UTC` 표기(KST로 읽히면 9시간 거짓말이 된다). 갱신 지연은 요약 줄에 남기고 코드는 토글로.
② 패널·차트 모두 provenance를 **네이티브 `<details>`** 뒤로 — 키보드·스크린리더 동작을 직접
구현하지 않는다. 계약(provenance 배열)은 그대로라 F4 패널·릴리스 게이트도 같은 데이터를 본다.
③ 패널 헤더의 **내부 패널 키 노출 제거**(`data-panel-key` 속성은 스타일·테스트 계약이라 유지).

### 덤으로 잡힌 결함 2건 (둘 다 접기 전에는 안 보였다)

- **LoginGate 터치 타겟 회귀(티켓 30)**: disabled 버튼 → `/signin` 링크로 바꾸면서 버튼이 갖던
  크기가 사라져 모바일 17px(WCAG 2.5.5 44px 미달). 링크에도 같은 크기 부여.
- **차트 선택 버튼 대비 미달**: amber 배경 위 muted 회색 4.3 < AA 4.5. provenance를 접기 전에는
  컨트롤이 화면 밖이라 axe가 측정을 못 해 통과처럼 보였다 — 접자마자 실패로 드러났다.
  선택 상태 글자색을 accent로 올려 해소.
- **브라우저 레인 부팅 실패**: playwright webServer가 `LOCAL_PROVIDER_CREDENTIAL_MODE=contract_only`만
  고정하고 짝인 owner workspace를 비우지 않아, 개발자 `.env.local`이 single_owner면 레인이 부팅
  거절됐다. 레인이 자기 조합을 끝까지 고정하도록 4개 키 pin.

### Changed files

`guest-panel-presenter.ts`(summary), `guest-panel.tsx`(details·헤더), `chart-workspace.tsx`(details),
`guest-terminal-shell.module.css`·`chart-workspace.module.css`(토글·터치 타겟·대비),
`playwright.config.ts`(레인 env pin), `tests/guest-panel-summary.test.ts`(5),
`tests/browser/screenshots/explicit-unavailable.png`(릴리스 게이트 스크린샷 갱신).

### Validation

- 단위 5 신규 + 기존 프리젠터/F4 회귀 0, `npm run check` 전 레인 green(1,361).
- **브라우저·a11y 레인 전체 green(86 passed)** — 수정 전 2 failed(터치 타겟·대비).
- 실 DOM: 토글이 기본 닫힘 → 클릭 시 전체 provenance 노출, 패널 헤더에 내부 키 없음 확인.

### Residual risks

- 요약 줄은 UTC 표기. KST 변환은 표시 계층 결정이 필요해 이월(티켓 36에서 로그인 화면과 함께).
- 빈 패널의 여백 자체는 그대로 — 데이터로 채우는 건 티켓 36.

## Context

사용자 QA(2026-07-21): "Required capability 이런 것들 왜 표시하는 거야, 사용하는 사람 입장에서는
전혀 불필요한 정보인데."

정확한 지적이다. `guest-panel.tsx:51-60`이 `Required capability` / `Configuration route` /
`Policy Version` / `Evidence Reference` / `Feed` / `Venue`를 패널 본문 `<dl>`로 렌더하고, 패널
헤더는 `market-overview` 같은 **내부 패널 키**(`:24`)를 그대로 노출한다. 즉 디버그·계약 정보가
사용자 화면의 1급 콘텐츠 자리에 올라와 있다. 값이 붙으면 이 줄들은 사라지지만(available outcome
에는 provenance 목록이 비어 있음), 데이터가 없는 패널에서는 화면 대부분이 이 노이즈다.

사용자 결정(2026-07-21): **기본 숨김 + 토글**. 정직성 설계(출처·정책 추적)는 유지하되 평소
화면에는 값과 "출처 · 시각"만 보인다.

## Owned scope

- `guest-panel.tsx`, `guest-panel-presenter.ts`, `guest-terminal-shell.module.css`
- `tests/` 해당 프리젠터·패널 테스트

## Acceptance

- 평상시 패널에는 값(또는 상태 한 줄) + `출처 · 신선도 · 시각` 한 줄만 보인다.
- provenance 전체는 토글(details/버튼)로 펼칠 때만 보이며, 접근성(키보드·aria-expanded) 유지.
- 패널 헤더의 내부 키 노출 제거(또는 토글 안으로 이동).
- 기존 정직성 불변식 회귀 0: 값 없는 outcome에 값이 생기지 않고, 상태 문구는 그대로 남는다.
