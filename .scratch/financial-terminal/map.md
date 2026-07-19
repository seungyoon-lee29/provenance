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
- [F3 Identity·Provider Connections core·layout 구축](./issues/12-build-identity-provider-layout.md): 불투명 hash-only session(generation·account authorization epoch·workspace switch·deletion fence), enumeration-safe email challenge(10분·link+10자 Crockford·5회 lockout·GET/prefetch consume 0), federated OIDC/GitHub(state/PKCE/nonce·exact callback·issuer+subject·암묵적 linking 없음), administrative erasure fence-first, AES-256-GCM ProviderConnections CRUD(masked·generation-first revoke), Workspace layout(drag/resize/split·guest draft vs 지속·adoption)을 TDD로 구현하고 적대적 리뷰(HIGH enumeration leak 등 수정) 후 cookie 세션 auth/connections 표면과 layout browser·성능 게이트까지 통합했다.
- [F7 포트폴리오 회계 구축](./issues/16-build-portfolio-accounting.md): coverage-typed TWR(pre-flow 관례·21% literal)·유일해 XIRR(다중해 fail-closed)·P&L price/fx/interaction 대수 항등 분해(32%·net 17)와 F7 소유 append-only 회계 원장(배당·transfer·corporate action, §8 trio·선형 교정·SEC-09 fence), 2:1 split raw/restated 동등·total_return 거절·scope_break 타입·주문 경로 없는 rebalancing proposal을 blind 38 + codex 반박 패널(4건 수정·1건 실측 기각)로 검증했다.
- [F8 Internal Paper Trading 구축](./issues/17-build-internal-paper-trading.md): append-only Paper journal fold(파생 reservation·§8 trio·exactly-once 시스템 이벤트)와 one-time PaperOrderIntent, BigInt 정수 tick simulation-v1(volume 10%·slippage buy 100.07/sell 99.93 literal), 2:1 split all-old/all-new·dividend·late valid fill, SEC-09 fence-first erasure, Paper↔Actual 행동 상호 불변을 blind 31 + codex 4축 반박 패널(실버그 5건 수정·1건 기각·intent 축 8 프로브 방어)로 검증했다. journal을 돈의 유일 변경 경계로 삼아 위조 fill/만료/genesis/fractional split을 경계에서 거절한다. 사후 Standards 축 code-review 1패스를 신규 게이트로 도입(경계 간 중복 로직 드리프트를 Spec 게이트가 놓치는 사각 보정).
- [F9 Broker Paper execution 구축](./issues/18-build-broker-paper-execution.md): F8과 journal 미공유 별도 broker book(통화별 minor-unit 정수 산술·파생 reservation)와 durable outbox+PendingBrokerSubmission을 한 account transaction으로 두어 **outbox 상태가 곧 안전성 증명**(pending_dispatch=미전송, route call 전 dispatched CAS claim, 그 뒤는 Submission Uncertainty→lookup만·blind retry 0)이 되게 했다. 4 named fault point를 새 dispatcher 재시작으로 외부 주문 ≤ 1로 수렴, generation-first revoke·commitWhileCurrent late-commit fence, (order,kind,revision)/payload divergent quarantine, paper-only 4-route allowlist로 Live 등록 0. blind 28 + codex 4축 반박 패널로 **실버그 10건 수정**(dispatch CAS·money 5[sell affordability·identity permutation·tick·safe-integer·교차통화]·erasure epoch 우회·intent 2), Standards 축 6건까지 정리했다.
- [F10 Broker Sync 구축](./issues/19-build-broker-sync.md): read-only broker projection에서 **CompleteBrokerSnapshot만이 승격 가능한 유일 진실**로 삼아, manifest 전 component(positions/cash/activity) contiguous paging + checksum fold + bounded skew일 때만 원자 승격하고 partial/gap/cursor-reset/divergent-checksum/skew/older-or-lower-epoch/unauthorized는 전부 held로 이전 complete snapshot·safe watermark를 불변 유지했다. lineage(`ExternalAccountIdentity+fingerprint+ProviderDataEpoch`)를 injective JSON key로 격리(ledger reset·새 epoch은 새 namespace, 구 event 미승계), event durable-unique dedupe + divergent/permutation quarantine, source 값 재도출 없이 보존(valuation은 F7), 60s/15min fixed-clock expiry(hard 뒤 frozen only), disconnect-retain freeze(current 제외·fresh sync만 복원), SEC-09 한 fence erasure + SEC-06 late fence(read 0), read-only 4-route allowlist로 Live 부재. blind 26(불일치 0) + codex 4축 반박 패널(실버그 5건 수정: epoch 단조·injective key·missing_component·이중 correction double-count·SEC-06 race) + Standards 축 1패스로 검증.
- [F4 정보 outcome·AI tracer 구축](./issues/13-build-data-outcomes-ai.md): non-chart Market Observation·news/filing Evidence를 provider/feed별 freshness(residual+cadence soft/hard)·error(401/403 3분기/429/timeout/5xx/malformed·future→invalid_response+quarantine) 매트릭스로 `InformationOutcome`에 정규화하고, ResearchAssistant가 source-owned AI Material Envelope 뒤에서 scripted Gemini/local rule을 실행하며 category policy(derivative/external-processing/consent 금지→호출 0)·SEC-06 pre-dispatch epoch 재검사·license narrowing·redaction 백스톱을 강제한다. PersonalCacheStore erasure fence(SEC-09)와 data 10s/AI 20s `withDeadline`를 배선하고, AT-01·AT-04를 blind test-authorship으로 검증(순환 import 실버그 검출), F4 outcome 매트릭스를 dev/test 라우트에 mount해 실브라우저 DOM에서 "API AND DOM 일치"·무한 spinner 없음을 확인했다.

## Implementation plan

- **현재 frontier**: [20 - F11 release integration](./issues/20-integrate-release-artifacts.md) — **claimed / ready-for-human**. 자율 검증 가능한 release 인프라(ZIP allowlist+SHA-256+secret-free 패키징, 문서 6종+link/stale-contract checker, screenshot provenance 매니페스트+synthetic paper-workspace 캡처, not_run posture 검사)는 완성(check 1,222/105 green). resolve 전 필요한 4 게이트는 환경/외부 계약이라 ready-for-human: production stack 드릴(Docker daemon), backup/restore 드릴, §11.3 5분 load, 두 guest-public 실데이터 스크린샷(USD 0·공급자 보류). 상세는 `progress/f11-plan.md`.
- [21 - 불변식 검증 adequacy](./issues/21-verify-invariant-adequacy.md) **resolved**: no-live·egress·money-conservation·actual/paper 격리 4 불변식을 fast-check standing property로 상시화(check 자동 편입, 각 가드 물리 mutation kill 실증) + Stryker를 안전 최상위 2 module(no-live·egress)에 좁게 도입(baseline 67.17%·break=60 회귀 게이트·seed 고정 결정론). Stryker가 SSRF property의 DNS-rebinding gap을 검출해 보강 유도. mutation 범위 확장(identity/vault/portfolio/accounting)은 residual.
- [22 - CI 게이트 도입](./issues/22-add-ci-gate-parity.md) **claimed / ready-for-human**: 사용자 결정(2026-07-19 GitHub 원격+Actions)으로 needs-info 해소. 공유 `content-gates.sh`(훅/CI 한 소스)+`npm run check` parity+`.github/workflows/ci.yml`(spec §16 레인 매핑, secret 0, ALLOW_PUSH 불변) 구현·커밋(59557aa). private 원격 생성 완료, 초기 push만 사람 대기(Claude tool-hook가 push 차단) → Actions 첫 run green 관측 시 resolve.
- F-spine 구현(F0~F10) resolved, F11(20)은 ready-for-human 게이트 대기. F11 게이트 2(backup 드릴)는 재실사 결과 **아키텍처상 blocker**(in-memory tracer, postgres 영속 부재 — persistence 계층 선행 필요, F11 스코프 밖)로 재분류.
- [10 - F1 비로그인 터미널 shell](./issues/10-build-guest-terminal-shell.md) → [11 - F2 chart tracer](./issues/11-build-chart-tracer.md) → [12 - F3 Identity·Provider Connections core·layout](./issues/12-build-identity-provider-layout.md)이 sequential contract spine을 완성했다.
- P1: [13 - F4 정보 outcome·AI](./issues/13-build-data-outcomes-ai.md) 뒤 [14 - F5 알림·외부 전달](./issues/14-build-alert-delivery-tracer.md), 그리고 [15 - F6 Actual Portfolio baseline](./issues/15-build-actual-portfolio-baseline.md)을 독립 scope로 진행한다.
- P2: F6 뒤 [16 - F7 포트폴리오 회계](./issues/16-build-portfolio-accounting.md)와 [17 - F8 Internal Paper Trading](./issues/17-build-internal-paper-trading.md)을 병렬화한다.
- P3: F8 뒤 [18 - F9 Broker Paper execution](./issues/18-build-broker-paper-execution.md), F6 뒤 [19 - F10 Broker Sync](./issues/19-build-broker-sync.md)을 병렬화한다.
- [20 - F11 release integration](./issues/20-integrate-release-artifacts.md)은 F5·F7·F9·F10을 모두 기다린 뒤 browser/accessibility/performance/load, Docker/ZIP/docs/screenshot gate를 통합한다.
- [21 - 불변식 검증 adequacy](./issues/21-verify-invariant-adequacy.md)는 F-spine 밖 cross-cutting 품질 backlog로, `docs/agents/collaboration.md` 예산 시퀀싱에 따라 토큰 여유 회복 시 착수한다(standing property/mutation으로 과거·미래 코드를 동시 검증).
- [22 - CI 게이트 도입](./issues/22-add-ci-gate-parity.md)은 로컬 pre-commit 훅과 동일 게이트를 원격에서 강제하는 두 번째 층이다. 원격 저장소·CI 플랫폼 결정(needs-info)이 선행돼야 한다.
- 각 ticket은 선행 issue가 resolved되면 `Blocked by`에서만 제거하고, `Depends on` 이력은 보존한다.

## Out of scope

- 초기 산출물에서 실제 브로커로 Live Trading 주문을 전송하는 기능
- 투자 수익을 보장하거나 개인 맞춤 투자자문으로 오인될 표현
