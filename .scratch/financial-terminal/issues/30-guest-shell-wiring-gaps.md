# 30 - guest shell 배선 누락 2건 (US10Y 스트립 셀 + LoginGate→/signin)

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 28, 12, 10
Blocked by: None
Owner: main
Claimed at: 2026-07-21T06:40:00Z
Last heartbeat: 2026-07-21T06:55:00Z

## Resolution (2026-07-21)

### Answer

① `createPublicFinancialInformation`에 `MarketInformation` 주입 seam — `index-us10y` 패널이
UST10Y read를 `GuestPanelValue`로 매핑(available일 때만 displayValue "N.NN%", provenance·
freshness·licenseScope 그대로 운반; 값 없는 outcome 원형 통과; 다른 패널은 treasury로 라우팅
절대 안 됨 — 테스트로 고정). page.tsx가 `publicMarketServer()` 주입.
② `F1_GUEST_MODE=public` dev QA override — production→synthetic 방향은 여전히 금지(기존 fence
테스트 회귀 0).
③ LoginGate disabled 버튼 → `/signin` 링크.

### Changed files

`public-financial-information.ts`(seam+매핑), `public-feature.ts`(주입·override),
`src/app/page.tsx`(배선), `guest-panel.tsx`(링크), `tests/guest-public-wiring.test.ts`(7).

### Validation

- network-off 단위 7 green(매핑·통과·미주입 stub·타 패널 불라우팅·override·production fence).
- `npm run check` 전 레인 green(1,319).
- 실 DOM: LoginGate가 `/signin` 링크로 렌더 확인(HMR). 스트립 실값 표시는 public 모드
  (`F1_GUEST_MODE=public` + `PUBLIC_MARKET_TREASURY_ENABLED=true`) 부팅 시 — dev 데몬 재시작 필요,
  synthetic 모드 동작 불변.

### Residual risks

- 스트립 public 모드 실 DOM 확인은 데몬 재시작 후(사용자 환경). 단위·매핑·하부 파이프라인(28에서
  live 검증)으로 커버.
- S&P500/NASDAQ/KOSPI 셀은 게스트 재배포 가능 소스가 없어 의도적으로 api_required 유지.

## Context

사용자 QA(2026-07-21): guest shell에 "없는 게 너무 많다". 진단 결과 대부분은 데이터 권리상 정직한
상태지만 **이미 구현된 것과 연결이 안 된 stale 배선 2건**은 실재:
① 상단 인덱스 스트립 `index-us10y` 셀이 티켓 28의 재무부 feed를 안 보고 F1 stub(api_required)을 봄.
② LoginGate가 F1 시절 disabled "로그인 준비 중" 버튼 그대로 — F3에서 `/signin`(이메일 챌린지·OIDC)
구현 완료됨.

## Owned scope

- **30-a**: `createPublicFinancialInformation`에 `MarketInformation`(treasury) 주입 seam —
  `index-us10y` 패널이 UST10Y public_display read → `InformationOutcome<GuestPanelValue>`로 매핑
  (available → displayValue "N.NN%" + provenance/freshness/licenseScope 그대로 운반; 값 없는
  outcome은 그대로 통과). 나머지 패널은 기존 stub 유지. page.tsx에서 `publicMarketServer()` 주입.
- **30-b**: `resolveGuestFeatureRuntime`에 dev QA용 mode override(`F1_GUEST_MODE=public`) —
  production+synthetic 금지 불변 유지.
- **30-c**: LoginGate disabled 버튼 → `/signin` 링크.

## Acceptance

- network-off 단위: us10y 셀 매핑(available/실패 통과/market 미주입 시 기존 stub), 다른 패널 불변.
- `F1_GUEST_MODE=public` + 게이트 on일 때 실 DOM 스트립에 US10Y 실값+freshness 라벨.
- LoginGate 클릭 → /signin 도달.
- 값 위조 0: synthetic 모드 동작·마커 불변.

## Out of scope

- S&P500/NASDAQ/KOSPI 스트립 셀(게스트 재배포 가능 소스 부재 — 정직한 api_required 유지).
- USD/KRW 셀(→ 티켓 32), 공시 패널(→ 티켓 33), KIS 지수(→ 티켓 31).
