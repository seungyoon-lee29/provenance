# 36 - 로그인 터미널 본체화 (헤더 로그인 + 메인 화면 개인 데이터 주입)

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 34, 26, 31, 12
Blocked by: None
Owner: main
Claimed at: 2026-07-21T10:45:00Z
Last heartbeat: 2026-07-21T10:50:00Z

## Resolution (2026-07-21)

### Answer

① **같은 셸, 다른 소스**: `createPersonalFinancialInformation`(포트 동형 drop-in)이 KIS가 답할 수
있는 패널만 개인 경로로 보내고 나머지는 공개 소스로 위임한다. 새 화면을 만들지 않았다 —
로그인 여부로 주입이 바뀔 뿐이다. 배선: `index-kospi`→KOSPI, `market-overview`→KOSDAQ,
`watchlist`→005930.
② **뷰어는 인자가 아니라 세션에서 확정**: 개인 소스는 세션이 있을 때만 조립되고, 조립 뒤에도
넘어온 게스트 뷰어로 개인 read를 하지 않는다. 어댑터 scope guard가 2차 방어(비-owner는 네트워크 0).
③ **헤더 계정 영역**: 비로그인 → 로그인, 로그인 → 워크스페이스·로그아웃.

### 배선하며 드러난 구멍 (이번 티켓의 실제 위험)

패널 값은 SSE 핸드오프(`/api/guest-terminal/updates`)로도 흐르는데, 이 라우트에는 **세션 검사가
전혀 없었다**. 게스트 전용일 때는 UUID 캡처빌리티로 충분했지만 개인 값이 흐르는 순간 부족하다.
→ 핸드오프에 소유 계정을 달고, 계정이 어긋나면 **거절하되 소모하지 않는다**(남의 요청 한 번으로
소유자 스트림을 지워버리면 그 자체가 서비스 거부).

### Changed files

`personal-financial-information.ts`(신규), `public-feature.ts`(조립 분기), `guest-load-registry.ts`
(소유 계정 바인딩), `guest-terminal/updates/route.ts`(세션 확인), `app/page.tsx`(세션 해석·주입),
`guest-terminal-shell.tsx`+css(헤더 계정), `chart-workspace.module.css`(대비),
`vitest.config.ts`+`tests/setup/server-only-stub.ts`(server-only 모듈 단위 테스트 가능화),
`tests/personal-terminal-wiring.test.ts`(3), `tests/guest-load-registry.test.ts`(3).

### Validation

- 단위 6 신규, `npm run check` 전 레인 green(1,367).
- 브라우저·a11y 레인 86 green.
- **실 KIS 라이브**: 로그인 상태 메인 화면에 KOSPI 6,747.95 / 코스닥 753.34 / 삼성전자 259,000
  렌더 확인(스크린샷). 게스트 HTML에는 개인 값 0건.
- **핸드오프 소유권 실측**: 소유자 렌더 → 쿠키 없는 청구 410(거절, 미소모) → 소유자 청구 200.

### 배선 중 잡힌 회귀 2건

- 모바일 헤더에서 계정 영역이 명령줄(`grid-column: 1/-1`) 위를 덮어 ↵ 버튼 클릭이 막혔다
  (브라우저 레인이 클릭 타임아웃으로 검출). 브랜드와 같은 칸 오른쪽으로 이동.
- 차트 컨트롤 `opacity: 0.5` 비활성 처리가 전경색을 배경과 섞어 대비 2.73까지 붕괴. opacity 대신
  색·테두리로 비활성을 표현(WCAG는 disabled 컨트롤을 면제하지 않는다).

### Residual risks

- 관심종목은 대표 종목 1건(005930)이다. 사용자별 관심목록 저장 + 목록 UI는 후속(39).
- S&P·NASDAQ은 KIS 해외지수 TR 미배선이라 여전히 정직한 api_required.
- 주요 뉴스·데이터 품질·차트는 소스 부재 그대로.
- 패널당 KIS 1콜 + 티켓 34의 1.1s 간격이라 로그인 첫 페인트는 순차적으로 채워진다(캐시는 후속).

## Context

사용자 결정(2026-07-21): **"로그인 터미널이 본체, 게스트는 쇼케이스"**, 그리고 **데이터 소스가
없는 패널은 로그인 트랙 데이터로 채운다**.

현재 구조의 문제: 개인(KIS) 실데이터는 `/workspace` 위젯에만 있고 메인 화면(`/`)의 터미널
셸과 끊겨 있다. 그래서 로그인해도 지수 스트립·시장 요약·관심종목은 여전히 `API 필요`다.
헤더에는 로그인 진입점 자체가 없다(`/signin` 링크는 우측 패널 안쪽에만).

셸은 이미 `GuestFinancialInformation` 포트로 패널 데이터를 받는다 — **소스를 뷰어에 따라 갈아
끼우는 것**이 새 화면을 또 만드는 것보다 작다.

## Owned scope

- `src/app/page.tsx`(뷰어 분기 주입), 셸 헤더(로그인/계정 상태)
- 개인 패널 정보 소스(패널키 → KIS 심볼 매핑, owner 전용)
- `tests/`

## Approach

- 세션이 있으면 개인 소스를, 없으면 기존 공개 소스를 주입한다(같은 포트, drop-in).
- 개인 데이터는 `audience: personal` 그대로 — **map line 16(재배포 금지) 불변**: 게스트 응답
  경로로 개인 값이 새지 않는 것을 테스트로 고정한다.
- 헤더: 비로그인 → 로그인 링크, 로그인 → 계정·로그아웃.

## Acceptance

- 로그인 상태에서 메인 화면 지수 스트립(KOSPI·KOSDAQ)과 시장 요약/관심종목이 KIS 실값으로 찬다.
- 비로그인 응답에는 개인 값이 절대 포함되지 않는다(테스트로 고정).
- 헤더에서 로그인/로그아웃이 실제로 동작한다.
- 값 없는 outcome에 값을 만들지 않는다(F1 불변식 회귀 0).
