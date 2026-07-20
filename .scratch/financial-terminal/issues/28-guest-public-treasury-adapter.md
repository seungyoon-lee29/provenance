# 28 - 게스트 공개 실데이터 어댑터 + guest shell 배선 (미 재무부 일별 수익률 곡선)

Type: implementation
Status: open
Triage: ready-for-agent
Depends on: 27, 13, 10
Blocked by: None
Owner: (unclaimed)

## Context

티켓 27이 미 재무부 소스를 **무키·live·public-domain(재배포 명확)**으로 확정했다. 사용자 결정
(2026-07-20): 게스트용 트랙 첫 소스는 **A) Daily Par Yield Curve(일별·수익률 곡선)** 하나를
end-to-end로 배포까지 먼저 굳히고, ECB FX·avg-rate·KRX EOD는 파이프라인 확립 후 얇게 증분한다
(rule of three — 둘째 실사례가 올 때 공통부 추출; 지금 멀티소스 프레임워크 선반영 금지).

## Owned scope

- **28-a 어댑터**: `createPublicMarketInformation`(KIS 어댑터 동형) — 저수준 HTTP 주입으로
  network-off 결정론 TDD. audience=`public` outcome(개인키 아님 → guest 재배포 허용). tenor 1개 =
  symbol 1개(`UST2Y`/`UST10Y` 등), `last`=금리%, `currency`=`"%"`(표시 단위), `priceBasis:"eod"`.
  freshness는 `cadence` policy(누락 발행 횟수 hard-expiry). XML(Atom) 파싱은 고정 필드
  정규식 추출 + 픽스처 테스트(ponytail: 스키마 변경 시 테스트가 잡음).
- **28-b 공개 라우트**: owner-gate 없는 public_display read(개인 라우트 `/api/market`와 분리).
  공개 데이터라 same-origin 불필요(단 심볼 zod 검증 유지).
- **28-c guest shell 배선**: `market-widget` 렌더 패턴(available일 때만 값+freshness) 재사용해
  guest shell(F1)에 공개 위젯 mount. 값 없는 outcome은 상태만.

## Acceptance

- 어댑터: 무키 fetch stub → available outcome(금리%·eod·audience public), 발행 누락 → cadence
  soft/hard 정직 age, 오류(404/5xx/malformed) → 값 없는 outcome. network-off TDD.
- 라우트: 심볼 → outcome JSON, 비밀·raw 0. guest(비로그인)도 값 받음(공개 라이선스).
- guest shell 실 DOM에서 값+freshness 표시, 무한 spinner 없음.
- opt-in 실 재무부 contract test(map line 17 요건) 1건 pass.

## 리스크 게이트

공개 feed = egress/no-redistribution 불변식(ticket 21) 표면. **red-first TDD → codex 적대 리뷰
(다른 계열) → 확인 건만 수정 → resolve.**

## Out of scope

- ECB FX·avg-rate·KRX EOD·DART 추가 소스 (파이프라인 확립 후 증분).
- 실제 배포/호스팅 (F11 게이트).
- 멀티소스 공통부 추출 (둘째 소스 실사례 시).
