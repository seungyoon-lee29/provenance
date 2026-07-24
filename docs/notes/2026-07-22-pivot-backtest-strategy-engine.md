# 2026-07-22 세션 결론 — 방향 전환: 백테스트 · 전략 엔진 · CLI/MCP

> 이 문서는 2026-07-22 대화의 **결론과 근거**를 다음 세션이 이어받기 위한 기록이다.
> 조사로 확정된 외부 사실은 §4에 있다 — **재조사하지 말 것**.
> 검토 후 폐기한 아이디어는 §8에 있다 — **재논의하지 말 것**.

---

## 1. 한 줄 결론

> **이 저장소를 "한국 시장 백테스트 + 실시간 모의투자 엔진"으로 좁히고, 얼굴은 CLI + MCP로 한다.**
> 웹·인증 트랙은 **단계적으로 걷어낸다 (A안 확정, §6 Stage 참조).** 게스트 시세 터미널(`/`)의
> 공개 데모 존치 여부만 Stage 3/F11 시점에 결정한다.

당초 "새 CLI 프로젝트를 따로 만든다"로 출발했으나, 이 저장소가 이미 체결 엔진·KIS 어댑터·성과 회계를
갖고 있어 **새로 만들지 않고 여기에 얹는 것**으로 확정했다.

---

## 2. 왜 이 방향인가 — 경쟁 상황

KIS 공식 저장소(`koreainvestment/open-trading-api`)에 이미 있는 것:

| 공식 도구 | 내용 |
|---|---|
| `backtester/` | QuantConnect **Lean** 엔진(Docker) 래핑 + 웹 UI. 과거 데이터 백테스트 |
| `strategy_builder/` | 비주얼 전략 설계 → `.kis.yaml` → **KIS 모의투자 계좌(`vps`)로 실주문** |
| `MCP/` | Kis Trading MCP + Code Assistant MCP |

**공식에 없는 빈칸 = 실전 키 시세 + 자체 체결 엔진으로 돌아가는 실시간 모의투자.**
공식의 "모의투자"는 KIS 모의서버에 진짜 주문을 넣는 것이고, 백테스트(Lean)와 **엔진이 다르다**.
따라서 "백테스트는 좋았는데 모의는 다르다"가 나와도 원인을 가릴 수 없다.

그리고 KIS 공식 문서(`backtester/README.md`)가 자기 모의투자를 이렇게 평가한다 — **인용 가치 있음**:

> "모의투자보다 실전투자 API 키 사용을 권장합니다. 모의투자 환경은 체결 가능한 주문 수량(유동성)이
> 실제 시장보다 크게 제한되어, 일부 종목·기간에서 시세가 누락되거나 부정확하게 채워질 수 있습니다."

→ **우리 차별점 3줄 요약** (면접 답변용):
1. 백테스트와 모의투자가 **같은 체결 엔진**을 쓴다 → 결과가 일관되고 원인 추적이 된다
2. 공식이 인정한 모의투자 유동성 제약을 **실전 호가 기반 자체 체결**로 우회한다
3. Docker + 웹서버 2개가 아니라 **CLI + MCP** — 에이전트가 쓰는 도구다

---

## 3. 확정된 결정

| # | 결정 | 근거 |
|---|---|---|
| 1 | **토스는 안 쓴다** | 토스 고유 기능(AI 시그널·커스텀 스크리너·테마)은 **비공식 WTS API에만** 있음 → TOS 위반 소지. 공식 토스 API는 KIS와 기능이 거의 완전히 겹침 |
| 2 | **토스 고유 기능은 KIS 원재료로 직접 만든다** | KIS 국내주식만 **156개 API** + `stocks_info/theme_code.py`·`sector_code.py` 마스터 보유. 재무비율 11종·실적추정·투자의견은 **토스에 없고 KIS에만 있음** |
| 3 | **백테스트는 캔들(OHLCV) only** | 과거 호가·과거 틱 모두 원천 불가 (§4) |
| 4 | **체결 근사는 Lean/Zipline 방식 이식** | 거래량 참여율 캡 + 슬리피지. 인용 가능한 근거 있음 (§4). ~~새로 발명하지 말 것~~ → **실제 구현은 선형 재파라미터화로 이탈, §4 정정 참조** |
| 5 | **한국 시장 규칙은 직접 구현** | 호가단위 라운딩·상하한가·거래세(0.15%+농특세)·VI — Lean이 안 해주는 부분 = 실제 기여 |
| 6 | **엔진은 하나, 관측치 정밀도만 다름** | `MarketObservation`에 호가가 있으면 정밀 모드, 캔들뿐이면 근사 모드. 리포트에 어느 모드였는지 명시 |
| 7 | **신뢰도 판정을 코드에 넣는다** | 주문량 / 호가잔량 비율로 "이 시뮬레이션을 믿어도 되는가"를 도구가 판정·경고 |
| 8 | **엔진 → 백테스트 → 모의투자 순서** | 모의투자는 장중(평일 09:00~15:30)에만 테스트 가능. 백테스트는 결정적이라 아무 때나 + CI에 넣을 수 있음 |
| 9 | **UI는 잘라낸다** | `/` 게스트 시세 터미널만 남김. §5 참조 |
| 10 | **`notification-center` 삭제** | 워커가 아무것도 안 돌려서 죽은 코드 2,342줄 |
| 11 | **`actual-portfolio`는 `calculation/`만 남기고 삭제** | TWR·XIRR은 순수 함수라 실계좌 없이도 백테스트 성과 리포트에 재사용됨. 실계좌 연동은 v2 |
| 12 | **저장소 이름 변경** | "값을 모르면 지어내지 않는다"가 핵심 가치인데 이름이 "가짜". 그리고 `Bloomberg`는 실제 상표 |
| 13 | **웹·인증 걷어내기 = A안, 단계 실행** (2026-07-22 최종) | 게이트 뒤에 보여줄 방이 없어 "수정"이 아니라 신규 개발이 됨. 엄밀함 자산(property·mutation·XIRR 2근·CAS outbox)은 엔진 측에 잔존. CLI+MCP가 이미 두 어댑터. B안은 mockstock 형태로의 회귀 (§8) |
| 14 | **Alpaca 삭제** | `src/**/alpaca*` 파일 0개 — 어댑터가 구현된 적 없음. env·스키마·테스트 문자열뿐. KIS가 브로커 역할 전담 |
| 15 | **research-assistant + dev-only 페이지 삭제** | `src/composition/` 참조 0건 = 프로덕션 배선 없음. `GEMINI_API_KEY` 미사용이 방증 |
| 16 | **credential-vault(234줄)는 남긴다** | CLI도 브로커 키를 디스크에 저장하므로 AES-256-GCM 암호화가 그대로 필요 |

### 포트폴리오 구성 (직무: 백엔드 / 풀스택)

- **이 저장소** — 백엔드 깊이: Ports & Adapters, property/mutation testing, 금액 정합성, 보안
- **OREUDA** — 풀스택 + 모바일: Expo RN + NestJS + PostGIS, 오프라인 outbox 동기화, GPS 판정
- **mockstock은 뺀다** — 셋 중 가장 얕음.
  단 **조건**: 이 저장소가 공개 + 배포되어야 함. private·미배포 저장소는 포트폴리오에 없는 것과 같다.

---

## 4. 조사로 확정된 외부 사실 — **재조사 금지**

### KIS 모의투자(VTS) 제약
- 도메인: 실전 `openapi.koreainvestment.com:9443` / 모의 `openapivts.koreainvestment.com:29443`
- WebSocket: 실전 `:21000` / 모의 `:31000`
- TR_ID: `T`/`J`/`C` 시작 TR만 모의에서 첫 글자가 `V`로 치환. 시세계열(`FHKST…`)은 실전·모의 동일
- **모의 미지원**: 과거일자 분봉 · 지수 현재가 · ETF/ETN 현재가 · 시간외 호가 · 조건검색
- **모의 지원**: 현재가 · 기간별시세(일/주/월/년, 100건/call) · 당일분봉(30건, 당일만) · 업종 기간별시세(50건) · 실시간 체결가/호가 WS · 국내주식 주문 전 유형
- 해외주식 모의: **일부 종목만 + 지정가만**
- 유량: **실전 초당 18건 / 모의 초당 1건**. 토큰 발급 초당 1건. 토큰 유효 1일(개인)
- **실전 키 + 모의 키 병행 사용 가능** — 토큰·유량이 계좌 단위로 독립. 공식 샘플(`kis_devlp.yaml`)이 두 쌍을 나란히 보관하는 구조

### 과거 호가/틱 — **불가능. 확정**
- KIS 전 카테고리(국내주식·해외·선물옵션·ELW·ETF/ETN·채권) 호가 API 전수 확인 → **전부 현재 시점 전용, 날짜 파라미터 없음**
- `일자별호가`/`기간별호가`/`시간대별호가` 코드 검색 **0건**
- **과거 틱(체결)도 불가** — `inquire_time_itemconclusion`, `inquire_ccnl`, `tradprt_byamt`, `pbar_tratio` 전부 "당일" 전용
- 토스 공식 API도 동일 — `Orderbook(ctx, symbol)` 로 symbol만 받음
- KRX가 "호가장"을 유료로 판매하나 **가격 미확인. 사용자가 유료 경로는 배제**

### 호가 없는 백테스트의 업계 표준 (소스 확인됨)
| 프레임워크 | 모델 | 파라미터 |
|---|---|---|
| Zipline | `VolumeShareSlippage` | `volume_limit=0.025` (초과분 다음 봉 이월 — 원문 0.25는 오기, §4 정정 ⑤) |
| QuantConnect **Lean** | `VolumeShareSlippageModel` | `volumeLimit=0.025`, `priceImpact=0.1` |
| Backtrader | `slip_perc` / `slip_fixed` | 비례 / 고정 |

→ **Lean 상수를 그대로 쓰면 "공식 백테스터와 동일 모델"이 된다.** 임의 파라미터 발명 금지.

**← 정정 (2026-07-24, 구현 실측 대조 시 — `simulator.ts:36` `SIMULATION_V1` 실독).**
① **틀린 전제**: 위 두 줄("Lean 상수 그대로 = 동일 모델", "임의 파라미터 발명 금지").
② **실제 구현**: 참여율 상한 **10%**(Zipline/Lean 2.5% 아님), 슬리피지 **선형** `min(25, 5+20×p)` bps(둘 다 quadratic `price×0.1×p²` 아님), **5bps 바닥**·**25bps 캡**(둘 다 0 바닥·무캡). 형태도 상수도 자체 재파라미터화다.
③ **왜 이 쪽이 나은가**: Zipline/Lean의 2.5%·quadratic은 소액 참여에서 슬리피지가 ~0.6bps로 **리테일 체결을 과소평가**한다. 우리 5–7bps 선형이 한국 리테일 현실에 더 보수적이고, 정수(BigInt) exact + adverse tick 라운딩이라 Zipline float보다 산술이 엄밀하다.
④ **어긋난 것 (서술 리스크)**: 이 문서·포폴 서술이 "공식과 동일 모델"이라고 주장하면 **거짓**이다(Zipline/Lean 아는 면접관에게 걸린다). 서술을 **"참여율 기반 슬리피지(Lean/Zipline 계열)를 한국 리테일 현실에 맞춰 선형·bps 상하한으로 재파라미터화"**로 고칠 것 — 이유 있는 이탈이 거짓 동일보다 강한 스토리다.
⑤ **부수 오류 정정**: 위 표 Zipline `volume_limit`은 **0.25가 아니라 0.025**(라이브러리 기본값 — zipline.ml4trading.io 소스 확인, Lean과 동일 값). `재조사 금지` 태그였으나 "동일 모델" 근거값이라 재확인해 표에서 정정함.
⑥ **미구현 갭 (T8 필수)**: `commissions are zero` — 결정5의 **거래세(0.15%+농특세)가 아직 fill path에 없다.** T8에서 슬리피지 함수 안이 아니라 **별도 cost/fee 모델**로 편입할 것(Zipline/Lean도 slippage와 commission을 분리, 거래세는 매도측만 붙는 비대칭). 참고로 `maxSlippageBps: 25`는 10% 상한 하에선 도달 불가(최대 7bps)라 사실상 미발동 파라미터다.

### 미확인 (필요 시 직접 확인할 것)
- **KIS WebSocket 41종목/세션 한도** — 공식 문서에서 확인 실패. 블로그 2곳만 일관되게 언급. **2차 출처**
- 실전 키의 WS/REST 유량이 모의보다 관대한지

---

## 5. 이 저장소 실제 상태 (2026-07-22 감사)

### 통과한 것 — 실제로 실행해서 확인
타입체크 ✅ / 린트 ✅(경고 1) / **테스트 1,375 통과** (1,405 중 30은 opt-in 라이브 계약) / 빌드 ✅ 21 라우트
소스 **19,400 LoC** / 테스트 **27,757 LoC** (1.4:1) / `TODO`·`FIXME`·`unimplemented` **0건**
Stryker: 466 mutants, 313 killed, **67.17%** (범위는 `runtime-policy.ts` + `network-policy.ts` 2개 모듈뿐 — README 주장과 일치)

### 진짜인 것 — 재사용 자산
- **`actual-portfolio/calculation/performance.ts:23` `computePortfolioReturn`** — 진짜 TWR. 외부 현금흐름 시점마다 구간 분할 후 기하 연결. 통화 혼재·비양수 기준액·파싱 실패에 fail-closed
- **`calculation/personal-return.ts:31` `computePersonalReturn`** — 진짜 XIRR(이분법). **데카르트 부호법칙으로 근이 2개인 경우 "유일한 답"이라 거짓말하기를 거부**. 적대적 리뷰에서 나온 20%/30% 2근 케이스가 주석에 기록됨
- **`paper-trading/internal/{journal,service,simulator,lifecycle,blotter}.ts`** — 진짜 체결 엔진.
  **거래량 참여율 상한(10%) + 슬리피지 bps** 모델. 고정가 아님. DAY 주문 만료·취소·액면분할·배당 처리 있음.
  → **§3-4에서 이식하려던 Lean 방식의 *선형 재파라미터화 버전*이 이미 여기 있다(§4 정정). 백테스트로 확장만 하면 된다**
- ~~**`paper-trading/broker/outbox.ts`** — commit-before-send + CAS 상태 전이(`pending_dispatch → dispatched → acknowledged/closed`), 종단 상태 재개방 불가, 멱등 커밋~~
  **← 정정 (Stage 1 실행 시)**: broker/ 전체가 §8 폐기 모델(F9 외부 브로커 전송)의 TEST-ONLY 구현체로 판명되어 삭제됨.
  CAS outbox 패턴 자체는 유효하니 라이브 주문(v2)을 열 때 `pre-stage1` 태그의 이 파일을 참조해 재구현할 것
- **`financial-information/data/kis-market-information.ts`** — 진짜 KIS 호출. `POST /oauth2/tokenP`(single-flight + refresh skew 캐시), `GET /uapi/domestic-stock/v1/quotations/inquire-price`. `EGW00201` 레이트리밋 처리, KST 장 세션 판정, KRX 휴장일 캘린더, `runtime-policy.ts:85` 호스트명 allowlist
- **`InformationOutcome` 규율** (available/unavailable/failed + freshness + license) — 백테스트에도 그대로 유용. "값을 모르면 지어내지 않는다"를 체결 엔진에 적용하면 곧 §3-7 신뢰도 판정
- ~~**`tests/property/money-conservation.property.test.ts`** — `fast-check` property 2개. 다만 범위는 `BrokerPaperBook`의 예약금 부기 검증이지, 체결·배당·분할을 가로지르는 원장 fold 보존 증명은 **아님**~~
  **← 정정**: 대상(BrokerPaperBook)이 F9와 함께 Stage 1에서 삭제됨. T2-b에서 영속 원장 위에 재수립(§6 명문화됨)

### 치명적 결함 — 손대야 할 것

**① 영속성이 없다 (최우선)**
`FencedKeyedStore`(`src/modules/notification-center/fenced-store.ts:36`)가 **평범한 in-memory `Map`**이고,
paper 원장 · 포트폴리오 저널 · 브로커 outbox가 전부 그 위에 있다.
`db/migrations/`에는 마이그레이션이 **4개뿐**(`0001_foundation`·`0002_personal_cache`·`0003_identity`·`0004_identity_receipt`)이고
**paper orders / journal / outbox 테이블이 아예 없다.**
→ **서버 재시작하면 모든 모의거래가 사라진다.** README의 "durable outbox"는 패턴만 맞고 durable이 아니다.

**② 워커가 아무것도 안 한다**
`src/worker/main.ts`(45줄)는 `/health`·`/ready`만 응답. `setInterval`/`cron` **0건**.
`DeliveryDispatcher`·`broker-sync/sync-worker.ts`가 `composition`·`worker` 어디에도 배선되지 않음.
→ 실제 배포하면 알림이 영원히 안 가고 브로커 싱크도 안 돈다.

**③ UI가 백엔드와 안 붙어 있다 — "엉망"의 정체**
| 위치 | 상태 |
|---|---|
| `/` 게스트 셸 | **진짜 동작** — 지수·차트·워치리스트·공시·헤드라인 실데이터 |
| `guest-terminal-shell.tsx:249-250` | `<LoginGate title="Paper Trading">` / `"AI Assistant"` 를 **무조건 렌더**. `account` prop 분기 없음 → **로그인해도 "로그인 필요"** |
| `guest-terminal-shell.tsx:254-267` | Paper Blotter가 **하드코딩 정적 JSX**. 데이터 바인딩 자체가 없음 |
| `/workspace` | `layout-presenter.ts:4-11` 위젯이 제목 + 좌표 문자열만 렌더 ("차트: 열 1, 행 1, 너비 6, 높이 8"). **실제 콘텐츠 0** |
| `/f4-panels`·`/f5-inbox`·`/f6-portfolio`·`/f8-paper` | dev-only(`devOnly()` → 프로덕션에서 `notFound()`), `"SYNTHETIC TEST DATA · INTERNAL TEST ONLY"` 배너 |

→ **F7·F8·F9는 프로덕션에서 도달 가능한 UI가 하나도 없다.** 잘 만든 라이브러리가 제품인 척하는 상태.
→ **경쟁하는 워크스페이스 UI가 두 개**(`/` vs `/workspace`)인 것 자체가 혼란의 원인.

**④ 모듈 경계 위반**
`FencedKeyedStore`가 도메인 모듈(`notification-center`) 안에 있는데 `paper-trading`·`actual-portfolio` 등 **23개 파일**이 이걸 쓴다.
Ports & Adapters를 표방하는 저장소에서 모듈 간 경계가 새는 지점.

---

## 6. 실행 순서

```
Stage 0 — 체크포인트 커밋 ✅ 완료 (이 메모를 포함한 커밋. 모든 파괴적 작업의 전제)

Stage 1 — ✅ 실행 완료 (2026-07-22, 4-에이전트 조사로 확장. 태그 pre-stage1 에서 복귀 가능)
  삭제 65파일 ~8,100줄 + 수정 24파일. 원안 + 조사로 추가된 것:
  · workspace 12파일 — /workspace 는 devOnly 가드가 없어 프로덕션 도달 가능했음.
    **로그인 착지를 /workspace → / 로 재지정** (auth signin·callback 라우트, signin-form, 게스트 셸 링크 제거)
  · dev 페이지 4개 + data-panel-presenter + browser spec 5개(paper-workspace.spec 은 이름과 달리 /f8-paper 스펙)
    + 스크린샷 manifest 정합 + f4 픽스처는 ai-material-catalog 만 (market-catalog 은 게스트 폴백 = 프로덕션)
  · research-assistant 전체 + paper-trading/internal/ai-resolver.ts (미배선 테스트 전용, contracts 의 유일 소비자)
    — f8-paper-erasure.test.ts 는 트림으로 paper erasure 커버리지 보존
  · **F9 paper-trading/broker/ 전체(1,206줄) + provider-connections/paper-transport/** — §8 폐기 모델의 구현체, TEST-ONLY
  · platform/delivery/ (소비자 0 — composition/local-delivery-keyring 과 별개) + shared/queue + shared/server
    (server-seam 예제는 platform/runtime 으로 대상 교체해 seam 검사 보존)
  · Alpaca — env 7줄(5줄 아님) + runtime-policy 스키마 + assertCredentialPolicy KIS-only 리팩터
    + playwright config 의 ALPACA env 주입 제거 + release-readiness 테스트 정합
  · 미사용 env 5종 제거 + IDENTITY_PERSISTENCE 칸 추가(스키마엔 있었으나 템플릿에 없던 실변수)
  · 문서: README·docs/release/architecture·privacy 배너, rights·provider-credentials 의 Alpaca/미사용 env 행 제거
  게이트: check(typecheck·lint·test·seam)+build green. 테스트 1,375 → 1,160 (삭제 18파일 215개와 정확히 대조됨)
  ⚠️ 감수한 커버리지 손실 2건:
    1. 교차-provider 격리 테스트 (runtime-policy) — provider 가 KIS 뿐이라 성립 불가. 두 번째 브로커 도입 시 재수립
    2. money-conservation property — 대상(BrokerPaperBook)이 F9 와 함께 삭제. **T2-b 에서 영속 원장 위에 재수립 (필수)**

Stage 2 — ✅ 실행 완료 (2026-07-23~24, 커밋 79a3abb..4ad59d0) + ✅ 독립 검증 완료 (2026-07-24, 아래 검증 기록)
  T1. FencedKeyedStore → platform/ 으로 이동 (인터페이스 유지, 이동만)
  T2-a. compose.yaml 에 postgres named volume 추가 (인프라 영속성)  ← T2-b보다 먼저
  T2-b. Postgres 구현체 + paper 원장/outbox 테이블 마이그레이션      ← 최우선, 타협 불가
    · **money-conservation property 를 새 영속 원장 위에 재수립** (Stage 1 손실분 복원 — 필수)
    · scripts/backup-drill.ts 의 ALL_TABLES 하드코딩(현재 identity·personal-cache 7개뿐)에
      paper 테이블 추가 — 안 하면 백업 게이트가 돈 원장을 안 본다
  T3. notification-center 삭제 (T1·T2 후에는 아무도 안 씀)
    · runtime-policy 의 EMAIL_*·MAILPIT_SMTP_*·DELIVERY_KEYRING_* 스키마 필드 + composition/local-delivery-keyring
      + bootstrap 의 deliveryKeyring 조립도 함께 제거 (.env.example 에서는 2026-07-22 에 이미 제거 —
      identity 이메일 로그인은 인메모리 outbox + peek 를 쓰므로 무관, 실측 확인)
  T4. actual-portfolio: calculation/ 만 남기고 broker-sync/·baseline/·journal/ 삭제
    · **경계 주의 (실측)**: calculation/ 중 TWR(performance)·XIRR(personal-return)·reporting-pnl 은 깨끗하지만
      corporate-actions·rebalancing·transfers 3개가 baseline/journal 타입에 의존 —
      타입을 calculation 쪽으로 이전해 살릴지, 3개를 함께 삭제할지 이때 결정
    · provider-connections/read-transport 도 함께 삭제 (유일 소비자 = broker-sync/sync-worker)
    · tests/f10-*.test.ts 도 함께 삭제

  ── Stage 2 검증 기록 (2026-07-24, 4-트랙 독립 검증: 실행대조·프로토콜·codex 적대 2차·Standards 축) ──
  판정: **코드·게이트 기준 완료** (체크리스트 1:1 대조, check/build green, 테스트 569/47skip 실측 일치).
  단 아래를 인지하고 후속 처리할 것:
  ① **PG 원장 배선 유예 (가장 중요)** — PgPaperJournalStore 는 존재·계약테스트 통과지만 composition 에
    조립되지 않음(프로덕션 소비자 0건 근거로 codex 가 배선을 범위 밖 판정). **T8 착수 시 배선이 선행 조건.**
    "영속화 완료"를 배포 기준으로 액면 그대로 읽지 말 것
  ② **codex 적대 2차 발견 triage** (메인 판정, 코드 실독 후):
    - BLOCKER 0. crash-window 원자성·SELECT-then-INSERT race 는 codex 가 반증(클린)
    - [T8 선행-필수] money-conservation property 가 memory store 전용 — PG round-trip 미커버.
      배선(①)과 함께 property 를 PG 러너로도 돌릴 것
    - [T8 전 결정] PaperMoney.amount 가 JS number (시뮬레이터 내부는 BigInt tick 정수지만 원장 fold·
      JSONB 왕복은 float) — KRW(scale 1)는 정수라 안전, USD(cents) 누적 fold 에서 드리프트 가능.
      minor-unit 정수 표현으로 전환할지 T8 설계 때 결정 (independent oracle 도 같은 float 라 property 가 못 잡음)
    - [보강 과제, MEDIUM] DB 방어층: entry JSONB 의 account/revision 과 관계형 컬럼의 일치를 CHECK/생성컬럼으로
      강제 안 함 + receipt/system_key → entry FK 없음. 현 코드 경로로는 불일치 생성 불가(원자 tx·컬럼을 entry 에서
      파생)하나 외부 쓰기·restore 경로에 무방비. 0006 마이그레이션 감
    - [재현 필요] 동시 동일-키 재시도 시 loser 가 원 outcome 대신 conflict 를 받는다는 주장 — store 레벨은
      receipt-first ON CONFLICT 로 duplicate 처리가 보이나 journal 캐시 레이어 race 는 미판정.
      실 PG 동시성 테스트로 판정할 것
    - [LOW, 문서화만] at_epoch Number() 캐스트는 2^53 초과 시 붕괴 — epoch 가 clock 유래(~1.7e12)라 비현실적
  ③ **프로토콜 간극** — 자체 규정상 money 경로 최상위 tier 요구사항 중 codex 반박 패널(1차, 10건 수정)은
    이행됐으나 **blind test-authorship 0건 · Standards 축 리뷰 미시행**(2026-07-24 검증에서 사후 집행 —
    LOW 1건, Executor 별칭, 즉시 수정됨). 다음 money 경로 작업은 착수 전 tier 선언부터 할 것
    → **기계 강제 도입 (2026-07-24, 사용자 결정)**: `.husky/commit-msg` + `scripts/gates/tier-gate.sh` —
      guarded 경로 커밋에 `Tier: top (...)` 트레일러 필수. 상세는 collaboration.md "Tier 게이트" 절
  ④ 규율 이탈 (경미): Stage 2 파괴적 삭제 전 태그 없음(pre-stage1 패턴 단절) · map 갱신이 커밋별이 아닌
    T그룹별 배치 · 이 §6 완료 마커 갱신 누락(지금 수정됨)

Stage 2-c — ✅ 실행 완료 (2026-07-24, 커밋 5387c5e. item 1~4 전부 + tier top 게이트 4종 —
  blind 6/6·codex 확정 5건 수정·Standards·mutation 2건. §8 동시성은 버그 확정→수정.
  상세: .scratch/financial-terminal/progress/stage2c-ledger-hardening.md)
  착수 문서(tier 선언 포함): .scratch/financial-terminal/progress/stage2c-ledger-hardening.md
  · PaperMoney minor-unit 정수 전환 (float fold 제거 — §6 검증기록 ② 참조)
  · money-conservation property 를 PG 러너로도 (composition 배선은 여전히 T8)
  · 0006 마이그레이션: JSONB↔컬럼 CHECK + receipt/system_key FK 방어층
  · 동시 동일-키 재시도 실 PG 판정
  · **tier-gate 체계의 첫 실전** — blind + codex 반박 + Standards 를 착수 전 선언하고 진행

Stage 3 — A 컷: 웹·인증 제거 (Stage 2 완료 + CLI 골격이 선 뒤에 실행)
  · identity(1,446) · provider-connections(606) · auth/signin 라우트 · terminal-view(2,747)
  · credential-vault(234)는 남긴다 — CLI 브로커 키 암호화 저장에 필요 (§3-16)
  · 게스트 시세 터미널(/) 존치 여부를 이 시점에 결정 — 기본 배포는 npm publish,
    웹 데모는 배포 운영 비용(호스트+PG+Redis)을 감수할 때만
    - **존치 시 필수 (옛 T5 유실분 복원, 2026-07-24 재발견)**: guest-terminal-shell 의 하드코딩
      LoginGate 패널(Paper Trading/AI Assistant, :248-249)과 정적 Paper Blotter(:253-263) 제거 —
      지금도 프로덕션 게스트 페이지에 "로그인 필요"로 렌더 중. 삭제 시엔 자동 소멸
  · **선행 필수 (실측된 지뢰들)**:
    - `ErasureParticipant` 인터페이스(identity 소속)를 shared/ 로 이전 — keep 대상인
      financial-information/data/personal-cache.ts 가 타입 의존 중. 안 옮기면 identity 삭제 시 컴파일 파손
    - `test:persistence-pg` + compose `persistence-integration` 서비스 재작성 — 대상 4테스트 중 3개가 identity 의존
    - backup-drill.ts 의 identity 테이블 5개·`identity_fence_seq` 하드코딩 제거
    - tests/browser/auth-flow.spec.ts 는 auth 와 함께 삭제
    - docs/release/ 6파일(setup·architecture·rights·privacy·backup·release)은 **삭제 금지, 재작성만** —
      release-docs 테스트가 6파일의 존재를 하드 요구. browser/perf npm 스크립트를 지우면
      setup.md·release.md 의 `npm run test:browser` 참조가 stale-ref 검사에 걸림 (문서를 같이 고칠 것)
    - scripts/package-release.ts + release/manifest.ts + check-release-docs.ts (239줄, 웹 ZIP 릴리스 전제)
      → npm publish 체제로 재정의할지 삭제할지 이때 결정 (CI 미배선이라 급하지 않음)
  · Stage 3 직후 문서 재정합: map.md Destination·spec.md 를 남은 시스템 기준으로 재작성,
    T8~T12 를 정식 티켓(42~)으로 작성, README 재작성(§9-4)

이후 — 엔진   ← 다음 세션은 여기부터 (2026-07-24 Stage 2-c 완료로 이동. Stage 3 는 CLI 골격 뒤)
  T8. 백테스트 엔진 — InternalPaperSimulator 를 과거 캔들로 확장 + 시간축 커서(look-ahead 차단)
    · 착수 시 선행 (§6 검증기록 ①): PgPaperJournalStore composition 배선 — 죽은 배선을 피하려면
      첫 실소비자(CLI 골격)와 함께 조립하는 것이 자연스럽다 → T8 슬라이스에 CLI 골격 포함,
      이것이 곧 Stage 3 의 선행 조건(CLI 골격)도 채운다
    · 거래세 cost 모델 설계 스케치 있음 (2026-07-24, §4 정정 ⑥ 후속):
      .scratch/financial-terminal/design/t8-transaction-cost-model-v1.md —
      slippage 와 분리·fill 이벤트에 비용 저장·(venue,종류,체결일) 세율 테이블·ETF 면제 분기·
      money-conservation 유출 leg 계약. 구현은 top tier (tier-gate)
  T9. 성과 리포트 — F7 TWR/XIRR 재사용 + MDD·승률 + 체결 신뢰도 집계
  T10. 전략 정의 층 + CLI + MCP  (선행 티켓 초안 있음: .scratch/financial-terminal/issues/40·41)
    · 에이전트 인터페이스 설계 메모 (2026-07-22, HyeokjaeLee/koreainvestment-cli 전체 정독 결과):
      [그대로 차용] ① SKILL.md 구조 — frontmatter description 에 한국어 트리거 문구 밀집 →
        황금원칙 → 명령 치트시트 → 상호작용 패턴(사용자 발화 예시 + 실행 명령 + 파싱할 JSON 필드명) →
        에러표(코드별 에이전트 행동) → 주문 전 안전 체크리스트 → "사람에게 제어를 돌려줘야 하는 경우"
      ② README 에 "이 프롬프트를 에이전트에게 복사해줘" 온보딩 블록 + installation.md 를
        "생략 금지" 결정론적 체크리스트로 ("WebFetch 말고 curl" 디테일 포함)
      ③ 3단 권한 경계 — 신규 시크릿 입력=사람 전용 / 저장된 토큰 조회=에이전트 자유 /
        주문=자연어 plan 확인 후 실행 (티켓 40 confirm token 철학과 일치)
      ④ exit code 0(성공)/1(일반)/2(API)/3(인증) + 설정 0600 + HOME override env
      ⑤ "패턴 0 — 프로파일 해석": 모호하면 list 먼저 → 실전 다중이면 질문. 기본은 항상 모의(paper)
      [개선해서 차용] --json 은 전 명령 예외 없이 + 성공/실패 동일 envelope + stdout 순수성
        (그 레포는 order 명령이 배너를 stdout 에 섞어 --json 파이프가 깨짐 — 반명제로 삼을 것).
        confirm 위에 --dry-run 별도 제공 (그 레포엔 없음)
      [반면교사] 테스트 0개 / 평문 YAML 크리덴셜(우리는 AES vault 재사용 = 차별점) / 에러만 비-JSON
      · MCP 없음이 확인됨 — CLI+SKILL.md 만으로도 에이전트 대응이 성립한다는 사례.
        우리는 41(MCP 카탈로그 3툴) + SKILL.md 양층으로 가면 차별화 유지
      · 토스 공식 API 실측 인벤토리(oauth client_credentials, /api/v1/prices·orderbook·candles·orders,
        x-tossinvest-account 헤더, {result} envelope)는 v2 토스 어댑터 때 이 레포 소스가 참조 지도가 됨
  T11. 실시간 모의투자 — 같은 엔진에 실시간 피드 연결
  T12. 호가 수집기 (돌리기 시작한 시점부터 정밀 모드 데이터가 쌓임)

규칙: 각 Stage 끝마다 4개 게이트(typecheck·lint·test·build) + 커밋. 자르기 전마다 git tag.
     테스트 개수가 삭제 모듈만큼 줄어드는 것은 정상 — 삭제 전/후 개수를 함께 기록할 것.
     각 Stage 커밋에는 .scratch/financial-terminal/map.md "트랙 상태" 한 줄 갱신을 포함한다.
     map.md·spec.md 상단에 supersede 배너 있음(2026-07-22) — 옛 Destination·이월 백로그를 따르지 말 것.
     스펙·맵 전면 재작성은 Stage 3 뒤 (지울 코드의 스펙을 미리 고쳐 쓰는 낭비 방지 + 게스트 터미널 미결).

     **이 메모의 전제와 실제 설계가 갈렸는데 결과가 더 나은 경우에도, 무엇이 어떻게 달랐고 왜 그 쪽이
     나았는지를 이 메모에 남긴다.** 결과가 좋으면 조용히 넘어가는 것이 가장 흔한 유실 경로다 —
     다음 세션은 틀린 전제를 그대로 믿고 같은 자리에서 다시 추정을 어긋낸다. 형식은 §5·§6이 이미 쓰는
     "← 정정 (언제/무엇 실행 시)" 그대로: ① 틀린 전제 ② 실제로 한 것 ③ 왜 그 쪽이 나았는지
     ④ 전제가 틀린 탓에 어긋난 것(작업량·범위 등)까지. 전제가 맞았을 때는 아무것도 적지 않는다.
```

**T2가 절대 먼저다.** 재시작하면 날아가는 원장 위에 백테스트를 얹는 건 말이 안 된다.
~~다만 `FencedKeyedStore`가 이미 seam이라 **재설계가 아니라 구현체 추가**다.~~

**← 정정 (2026-07-23 T2-b 실행 시): 이 전제는 틀렸다.** `FencedKeyedStore`는 **쓸 수 있는 seam이
아니었다.** 동기 KV(`write`/`get`/`list`) 인터페이스로는 entry + §8 receipt + exactly-once
system_key + owner를 **한 트랜잭션으로 묶을 수 없다** — 이 원자성이 곧 "돈 이동과 그 멱등 기록이
절대 갈라지지 않는다"는 T2-b의 핵심 보증이라, 기존 seam에 구현체만 끼우는 길은 애초에 없었다.
실제로 한 것은 **새 포트 도입**이다: `PaperJournalStore`(`journal.ts:146`, async·트랜잭션 단위
append)를 만들고, `FencedKeyedStore`는 **읽기용 in-memory fold 캐시로 강등**했다
(`journal.ts:369·375` — 이제 durable 진실이 아니라 store 스냅샷의 투영이다).
결과적으로 이 쪽이 낫다: 캐시와 durable 진실이 타입으로 분리돼 hydration·fence 재심사·
stale 캐시 재구축이 명시적 단계가 됐고, 메모리 구현체가 그대로 오라클이 돼 pg 구현체가 **같은 계약
스위트**를 통과한다. 다만 "구현체 추가"라는 전제 덕에 잡았던 **작업량 추정은 틀렸다** —
포트 도입은 `service`/`simulator`/`lifecycle`/`paper-erasure`와 f8 테스트 8파일에 async 리플을 냈다.
같은 판단이 필요한 T3·T4에서는 "이미 seam이 있다"를 **동기/비동기와 트랜잭션 경계까지 확인한 뒤에만**
믿을 것.

**T2-a를 T2-b보다 먼저 하라.** 2026-07-22 확인 결과 `compose.yaml`의 postgres 서비스에
**볼륨 마운트가 없고 최상위 `volumes:` 섹션도 없다.** 데이터가 컨테이너 레이어에만 있어서
`docker compose down` 한 번이면 identity/session·시세 캐시까지 전부 사라진다.
즉 **영속성 결함이 앱 레이어(§5-①)와 인프라 레이어 두 겹**이다.
T2-b로 테이블을 만들어도 T2-a 없이는 컨테이너를 내리는 순간 같이 사라지므로 의미가 없다.

**T12를 일찍 시작할수록 좋다** — 과거 호가는 확보 불가능하므로, 수집기를 돌린 시점 이후 구간만 정밀 모드가 된다.
다만 v1 데모에는 **며칠치면 충분**하다 (근사 vs 정밀 모드 비교 리포트 한 장이 목적).

---

## 7. 이번 세션에서 이미 한 것

### T6 이름 변경 — 완료
`fakebloomberg` → **`provenance`**. 로컬 폴더 · GitHub 저장소(`seungyoon-lee29/provenance`) · `package.json` ·
git remote · 문서 17개 파일 전부 치환. **4개 게이트 재확인 통과** (typecheck / lint 0 error / **테스트 1,375 통과** / 빌드).

**⚠️ 의도적으로 `fakebloomberg`로 남긴 3곳 — 절대 바꾸지 말 것:**

| 위치 | 문자열 | 이유 |
|---|---|---|
| `src/platform/credential-vault/aad.ts:14` | `"fakebloomberg/credential-vault/v1"` | **AES-256-GCM AAD.** 바꾸면 DB의 기존 암호문(사용자 KIS 키 등)을 영구히 복호화 불가 |
| ~~`src/platform/delivery/delivery-aad.ts:33`~~ | ~~`"fakebloomberg/delivery-vault/v1"`~~ | Stage 1에서 모듈째 삭제됨 (프로덕션 암호문이 존재한 적 없어 안전) |
| `src/modules/notification-center/webhook-inbox.ts:58` | `"fakebloomberg/webhook-tombstone"` | 해시 도메인 분리자. 게다가 이 모듈은 T3에서 삭제 예정 |

앞의 두 곳에는 이 이유를 설명하는 주석을 달아뒀다. 정말 바꾸려면 `/v2`로 버전을 올리고
**재암호화 마이그레이션을 반드시 동반**해야 한다.

**⚠️ 사용자 후속 조치**: DB 계정·DB명이 `fakebloomberg` → `provenance`로 바뀌었다.
Postgres init은 최초 1회만 실행되므로 기존 도커 볼륨은 여전히 옛 이름을 갖고 있다. 한 번 재생성 필요:
```bash
npm run compose:down   # 또는 docker compose down -v
npm run compose:up
```
날아가는 것은 로그인 세션과 시세 캐시뿐이다 (모의거래는 어차피 메모리에만 있음 — 그게 T2에서 고칠 문제).

### KIS 실전 키 칸 — 스키마까지만
- `.env.example` — `KIS_LIVE_APP_KEY` / `KIS_LIVE_APP_SECRET` 칸 추가 (실전 키는 **시세 조회 전용**, 주문 경로 배선 금지)
- `src/composition/runtime-policy.ts` — 위 두 변수를 zod 스키마에 optional 추가
- **미완**: 실전/모의 키 **선택 로직은 배선하지 않았다.** 어느 조회에 실전 키를 쓸지는 T8에서 결정.
  실전 키가 주문 경로에 닿지 않는다는 것을 `No Live Trading` 불변식 테스트로 **명시적으로 커버할 것**
- **사용자가 직접 할 일**: `.env.local`에 위 두 줄을 추가하고 실전 앱키/시크릿을 넣는다.
  (에이전트는 시크릿 파일을 읽지 않는다 — 평문 노출 금지 규칙)

### Stage 0 체크포인트 커밋 — 완료
**파일명 규칙 (실측)**: docs 파일명은 ASCII로 — F11 릴리스 매니페스트 테스트가 `git ls-files`의
quotepath 인용 경로(비ASCII 파일명)를 fail-closed로 거부한다. 이 메모도 원래 한글 파일명이었다가
pre-commit에서 릴리스 테스트 4개가 실패해 `2026-07-22-pivot-backtest-strategy-engine.md`로 바꿨다.

2026-07-22, 두 커밋으로 분리:
1. **세션 전 WIP** — 협업 규칙 손질 + 이슈 초안(05·39·40·41) + .scratch/README
2. **이름 변경 + KIS 실전 키 칸 + 이 메모** = Stage 0 체크포인트. 이후 모든 파괴적 작업(Stage 1~3)은
   이 커밋 뒤에서만 하며, 틀리면 `git reset --hard` 로 여기로 복귀한다.

push 는 하지 않았다 — 원격 반영은 사용자가 `ALLOW_PUSH=1` 로 직접 실행한다 (저장소 훅 규칙).

---

## 8. 검토 후 폐기 — **재논의 금지**

| 폐기한 것 | 이유 |
|---|---|
| **토스 비공식 WTS API 사용** | TOS 위반 소지. 공개 포트폴리오에 부적합 |
| **`tossinvest-cli` 포크** | 23,600줄 중 9,614줄이 토스 웹세션 클라이언트 = 불필요 + 리스크 원천. 설계(Broker 인터페이스·주문 안전 게이트·MCP catalog 3툴)는 MIT라 참고만 |
| **KIS 모의투자 계좌를 체결 원천으로 사용** | 백테스트는 애초에 못 씀 → 자체 엔진이 어차피 필요. 유량 초당 1건. 체결 알고리즘 비공개. **KIS 공식 문서가 직접 "유동성 제한으로 부정확"이라고 인정** |
| **별도 신규 CLI 저장소 생성** | 체결 엔진·KIS 어댑터·성과 회계를 재구현하게 됨. 6~10주 → 이 저장소에 얹으면 훨씬 짧고, 미완성 2개 대신 완성 1개가 됨 |
| **큐 위치 시뮬 / 시장충격 모델을 v1에 포함** | 큐 앞당김(취소)은 관측 불가. 임의 파라미터는 정확도를 높이는 척하며 낮춤. v2 옵션(`--fill-model queue`) |
| **UI를 새로 디자인** | 이미 검증된 것(a11y·성능 예산·Playwright)을 깨뜨림. 잘라내는 게 손대는 양이 더 적음 |
| **실계좌 연동(F6/F10) 유지** | 워커가 안 돌아 죽은 코드. TWR/XIRR은 실계좌 없이도 재사용됨. v2 |
| **KRX 유료 호가 데이터 구매** | 사용자가 배제 |
| **B안: 웹 인증 트랙 유지 + 로그인 게이트 수정** (2026-07-22 최종 기각) | "두 줄 수정"처럼 보이지만 게이트 뒤에 보여줄 방(세션 인지 Blotter·per-user 원장 바인딩)이 없어 **신규 개발**이고, 그마저 T2(영속성)에 막혀 있음. 인증 보안 자산을 잃는다는 반론은 과장 — 엄밀함의 계급(property·mutation·XIRR 2근·CAS outbox·AES vault)은 엔진 측에 다수 잔존하고, 사용자 인증 서사는 OREUDA(NestJS)가 자연스러운 집. CLI+MCP가 이미 같은 포트를 소비하는 두 어댑터라 아키텍처 증명에 웹 불필요. 결정적으로 B를 끝까지 가면 "웹 모의투자 앱" = **포트폴리오에서 뺀 mockstock 형태로의 회귀**. 단 하나 열어둔 것: 게스트 터미널(비로그인 데모) 존치 — Stage 3/F11 에서 결정 |

---

## 9. 아직 안 정한 것

1. **전략 정의 방식** — TS 파일로 직접 작성(표현력 높음, 공식 Strategy Builder의 YAML 대비 우위) vs 선언형.
   이 저장소가 TypeScript이므로 **전략을 TS 함수로 쓰게 하는 쪽이 자연스럽다**
2. **대상 시장** — 국내주식만 / 국내 + 지수 / 해외 포함
3. **실전 키를 어느 조회에 쓸 것인가** (T8에서 결정)
4. **README 재작성** — 이름이 `provenance`가 됐으니 상단 문구를 새로 쓸 것.
   "값을 모르면 지어내지 않는다"(데이터 정직성) + "백테스트와 모의투자가 같은 엔진을 쓴다"를 엮으면 자연스럽다
5. **게스트 시세 터미널(/) 공개 데모 존치** — Stage 3/F11 시점 결정. 그때까지 유지 비용 0이므로 미리 정하지 않는다
6. **v2 범위와 착수 시점** — 스크리너(KIS 재무비율 11종)·LLM 시그널·큐 시뮬·해외. 원칙: v1(백테스트+모의투자+CLI/MCP)이 완결·배포된 뒤에만 착수

---

## 10. 근거 자료 위치

- KIS 공식: `github.com/koreainvestment/open-trading-api` — `examples_llm/`(카테고리별 API), `stocks_info/`(종목·테마·업종 마스터), `backtester/`, `strategy_builder/`, `MCP/`
- KIS API 포털: `apiportal.koreainvestment.com/apiservice` (JS SPA — WebFetch 불가, 브라우저 필요)
- 참고 CLI: `github.com/JungHoonGhae/tossinvest-cli` (Go, MIT) / `github.com/HyeokjaeLee/koreainvestment-cli` (TS, MIT, ⭐0)
- 체결 모델: Lean `Common/Orders/Slippage/VolumeShareSlippageModel.cs`, Zipline `finance/slippage.py`
