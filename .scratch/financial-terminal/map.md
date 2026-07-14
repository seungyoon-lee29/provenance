# 한국어 금융 터미널 Wayfinder Map

## Destination

실데이터와 데이터 품질 상태를 명확히 표시하고, 비로그인 시장 조회, 로그인 사용자별 포트폴리오와 설정, 커스터마이징 가능한 고밀도 터미널 UI, Paper Trading, 안전한 브로커 연결 구조를 포함한 운영 배포 가능 MVP의 승인된 스펙을 만든다. 최종 구현은 테스트·문서·Docker·ZIP·실데이터 스크린샷까지 검증한다.

## Notes

- 한국어를 기본 언어로 사용한다.
- 공개 시장 정보는 로그인 없이 실제 데이터로 제공한다.
- 모든 Market Observation은 Data Freshness, 출처와 기준 시각을 포함한다.
- Paper Trading은 완전 구현하고 Live Trading 주문 전송은 초기 산출물에서 비활성화한다.
- 사용자별 Provider Credential은 암호화해 저장한다.
- 주요 스킬: research, prototype, domain-modeling, codebase-design, to-spec, to-tickets, tdd, implement, code-review, diagnosing-bugs.

## Decisions so far

- Paper Trading은 기본이자 완전 구현 범위이며 Live Trading 전송은 비활성화한다.
- TypeScript 모듈형 모놀리스, PostgreSQL, Redis, 비동기 워커를 사용한다.
- Market Observation은 다섯 가지 Data Freshness 상태와 출처·기준 시각을 제공한다.
- Provider Credential은 서버 환경변수 또는 AES-256-GCM 암호화 저장소에만 둔다.
- 비로그인 공개 조회와 이메일·Google·GitHub 회원 로그인을 지원한다.
- [공급자 지원 범위 조사](./issues/01-research-provider-capabilities.md): 공공 정본을 먼저 연결하고, 개발은 Alpaca IEX·KRX EOD·사용자별 KIS로 검증하며, 공개 실시간 시세·옵션·뉴스는 표시/재배포 계약이 확인된 feed만 활성화한다.

## Not yet specified

- 브로커 샌드박스 자격증명으로 검증 가능한 계좌·주문 범위
- 알림 전달 채널과 운영 이메일 제공자

## Out of scope

- 초기 산출물에서 실제 브로커로 Live Trading 주문을 전송하는 기능
- 투자 수익을 보장하거나 개인 맞춤 투자자문으로 오인될 표현
