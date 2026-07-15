# 한국어 금융 터미널 Wayfinder Map

## Destination

실데이터와 데이터 품질 상태를 명확히 표시하고, 비로그인 시장 조회, 로그인 사용자별 포트폴리오와 설정, 커스터마이징 가능한 고밀도 터미널 UI, Paper Trading, 안전한 브로커 연결 구조를 포함한 운영 배포 가능 MVP의 승인된 스펙을 만든다. 최종 구현은 테스트·문서·Docker·ZIP·실데이터 스크린샷까지 검증한다.

## Notes

- 한국어를 기본 언어로 사용한다.
- License Scope가 공개 표시를 허용한 시장 정보는 로그인 없이 실제 데이터로 제공하고, 그 밖의 요청은 숫자를 만들지 않고 Information Outcome을 표시한다.
- 모든 Market Observation은 Data Freshness, 출처와 기준 시각을 포함한다.
- Paper Trading은 완전 구현하고 Live Trading 주문 전송은 초기 산출물에서 비활성화한다.
- 사용자별 Provider Credential은 암호화해 저장한다.
- 현재 단계의 외부 데이터·뉴스·AI 공급자 구독 예산은 USD 0이며 유료 공급자와 표시·재배포 계약은 보류한다. 무료 API도 License Scope가 허용하는 화면과 사용자에게만 사용한다.
- Gemini는 시장·뉴스·공시·차트·Actual/Paper Portfolio와 주문 문맥을 포함한 모든 지원 자료 유형에 사용할 수 있다. 자료 유형만으로 차단하지 않으며 Viewer Context, 원천 License Scope, 최소화와 비밀 redaction은 독립적으로 적용한다.
- KIS Open API는 사용자 결정에 따라 구독비 USD 0의 `free_personal` 공급자로 취급하고 개인 목적에 유용한 시세·차트·계좌·모의투자 capability를 활성 후보로 둔다. Alpaca Basic의 무료 IEX·주식 이력·indicative option·Paper Trading도 개인 범위에서 사용한다. 어느 개인 key도 비로그인 공용 feed나 다른 사용자 cache로 재배포하지 않는다.
- 로컬 `.env.local`에는 Gemini, Alpaca, KIS, Open DART와 KRX Open API 변수 이름이 구성돼 있다. 값·유효성·API별 승인 상태는 별도 contract test 전에는 확정하지 않는다.
- 주요 스킬: research, prototype, domain-modeling, codebase-design, to-spec, to-tickets, tdd, implement, code-review, diagnosing-bugs.

## Decisions so far

- Paper Trading은 기본이자 완전 구현 범위이며 Live Trading 전송은 비활성화한다.
- TypeScript 모듈형 모놀리스, PostgreSQL, Redis, 비동기 워커를 사용한다.
- 사용 가능한 Market Observation은 세 가지 Data Freshness 상태와 출처·기준 시각을 제공하고, API 필요·데이터 없음·공급자 실패는 Information Outcome으로 구분한다.
- Provider Credential은 서버 환경변수 또는 AES-256-GCM 암호화 저장소에만 둔다.
- 비로그인 공개 조회와 이메일·Google·GitHub 회원 로그인을 지원한다.
- [공급자 지원 범위 조사](./issues/01-research-provider-capabilities.md): 무료 공공 정본을 먼저 연결하고 Alpaca Basic과 유용한 KIS 개인 capability를 권리 범위 안에서 사용한다. Gemini는 모든 지원 자료 유형에 적용하며 유료 시세·옵션·뉴스 feed는 보류한다.
- [고밀도 터미널 Workspace 프로토타입](./issues/02-prototype-terminal-workspace.md): 워크스테이션 그리드를 기본으로 하고 종목 리서치 근거 패널과 하단 Paper Blotter를 결합하며, 모든 위젯·패널 조절과 모바일 단일 열 축소를 지원한다.
- [데이터·Identity 모듈 설계](./issues/03-design-data-identity-modules.md): FinancialInformation, ResearchAssistant, Identity, ProviderConnections와 NotificationCenter를 TerminalView가 조합한다. source-owned AI/Alert resolver, Evidence Reference와 Information Outcome으로 출처·권리·실패를 일관되게 처리하고 Provider Credential 원문 접근을 차단한다.
- [포트폴리오와 거래 모델 결정](./issues/04-design-portfolio-trading-model.md): ActualPortfolio와 PaperTrading을 별도 원장·module로 격리하고, 실제 계좌는 읽기 전용으로 동기화하며, Paper 주문만 명시적인 예약·불확실성·대조 경계를 거쳐 전송한다.
- [테스트 seam과 성능 예산 결정](./issues/05-define-testing-seams.md): `free_only` 실행 모드, public Interface 중심의 독립 oracle, network-off 결정론적 CI와 opt-in sandbox contract, freshness·HTTP·browser·worker의 수치 합격 예산을 확정했다.
- [무료 알림 전달과 운영 이메일 경로 조사](./issues/06-research-free-alert-delivery.md): 인앱 Notification Record를 정본으로 두고 표준 Web Push, Resend Free 운영 email과 Mailpit local/CI 경로, consent·quota·retry·delivery fact를 확정했다.
- [승인 가능한 MVP 스펙 작성](./issues/07-write-approved-mvp-spec.md): [승인 MVP spec](./spec.md)에 사용자 흐름, module/interface, 정보·권리·보안, Actual/Paper, 알림, 성능·테스트·배포 gate와 F0~F11 구현 ownership을 통합했다.
- [MVP 구현 티켓 분해](./issues/08-decompose-mvp-implementation.md): F0~F11을 dependency, single owned scope, interface contract와 acceptance oracle이 있는 issue 09~20으로 분해했다.
- [F0 기반·공유 계약·vault 구축](./issues/09-build-foundation-contracts.md): Next.js·worker·PostgreSQL·Redis tracer, migration과 internal-network PR harness, shared contract, AES-256-GCM vault와 fail-closed authorized transport/runtime composition을 구현했다.
- [F1 비로그인 터미널 shell 구축](./issues/10-build-guest-terminal-shell.md): 값이 허용된 공개 outcome만 provenance와 함께 표시하고, 값 없는 unavailable/failed 상태, 동일 load SSE update, 2초/10초 deadline, desktop/mobile·접근성·성능 gate를 갖춘 guest Workspace를 구현했다.
- [F2 chart tracer 구축](./issues/11-build-chart-tracer.md): FinancialInformation chart port와 TerminalView chart adapter로 21개 range×interval(1M/1D→22, 1Y/1W→52) canonical window, OHLCV·Price Basis·Evidence·freshness bar, MA/Bollinger/RSI/MACD versioned oracle, revision/cancel/latest-only + 10초 deadline tracer, soft→오래됨·hard→값 없음·future/malformed→invalid_response 정책을 구현하고 guest 중앙 열 예약 seam에 mount했다.

## Implementation plan

- **현재 frontier**: [12 - F3 Identity·Provider Connections core·layout](./issues/12-build-identity-provider-layout.md)
- [10 - F1 비로그인 터미널 shell](./issues/10-build-guest-terminal-shell.md) → [11 - F2 chart tracer](./issues/11-build-chart-tracer.md) → [12 - F3 Identity·Provider Connections core·layout](./issues/12-build-identity-provider-layout.md)이 sequential contract spine을 완성한다.
- P1: [13 - F4 정보 outcome·AI](./issues/13-build-data-outcomes-ai.md) 뒤 [14 - F5 알림·외부 전달](./issues/14-build-alert-delivery-tracer.md), 그리고 [15 - F6 Actual Portfolio baseline](./issues/15-build-actual-portfolio-baseline.md)을 독립 scope로 진행한다.
- P2: F6 뒤 [16 - F7 포트폴리오 회계](./issues/16-build-portfolio-accounting.md)와 [17 - F8 Internal Paper Trading](./issues/17-build-internal-paper-trading.md)을 병렬화한다.
- P3: F8 뒤 [18 - F9 Broker Paper execution](./issues/18-build-broker-paper-execution.md), F6 뒤 [19 - F10 Broker Sync](./issues/19-build-broker-sync.md)을 병렬화한다.
- [20 - F11 release integration](./issues/20-integrate-release-artifacts.md)은 F5·F7·F9·F10을 모두 기다린 뒤 browser/accessibility/performance/load, Docker/ZIP/docs/screenshot gate를 통합한다.
- 각 ticket은 선행 issue가 resolved되면 `Blocked by`에서만 제거하고, `Depends on` 이력은 보존한다.

## Out of scope

- 초기 산출물에서 실제 브로커로 Live Trading 주문을 전송하는 기능
- 투자 수익을 보장하거나 개인 맞춤 투자자문으로 오인될 표현
