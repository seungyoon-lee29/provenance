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
| 4 | **체결 근사는 Lean/Zipline 방식 이식** | 거래량 참여율 캡 + 슬리피지. 인용 가능한 근거 있음 (§4). **새로 발명하지 말 것** |
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
| Zipline | `VolumeShareSlippage` | `volume_limit=0.25` (초과분 다음 봉 이월) |
| QuantConnect **Lean** | `VolumeShareSlippageModel` | `volumeLimit=0.025`, `priceImpact=0.1` |
| Backtrader | `slip_perc` / `slip_fixed` | 비례 / 고정 |

→ **Lean 상수를 그대로 쓰면 "공식 백테스터와 동일 모델"이 된다.** 임의 파라미터 발명 금지.

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
  → **§3-4에서 이식하려던 Lean 방식이 이미 여기 있다. 백테스트로 확장만 하면 된다**
- **`paper-trading/broker/outbox.ts`** — commit-before-send + CAS 상태 전이(`pending_dispatch → dispatched → acknowledged/closed`), 종단 상태 재개방 불가, 멱등 커밋
- **`financial-information/data/kis-market-information.ts`** — 진짜 KIS 호출. `POST /oauth2/tokenP`(single-flight + refresh skew 캐시), `GET /uapi/domestic-stock/v1/quotations/inquire-price`. `EGW00201` 레이트리밋 처리, KST 장 세션 판정, KRX 휴장일 캘린더, `runtime-policy.ts:85` 호스트명 allowlist
- **`InformationOutcome` 규율** (available/unavailable/failed + freshness + license) — 백테스트에도 그대로 유용. "값을 모르면 지어내지 않는다"를 체결 엔진에 적용하면 곧 §3-7 신뢰도 판정
- **`tests/property/money-conservation.property.test.ts`** — `fast-check` property 2개. 다만 범위는 `BrokerPaperBook`의 예약금 부기 검증이지, 체결·배당·분할을 가로지르는 원장 fold 보존 증명은 **아님**

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

Stage 1 — 양쪽 계획 공통의 죽은 코드 삭제 (판단 리스크 0)   ← 다음 세션은 여기부터
  · /workspace 페이지 + api/workspace/{layout,reset}
  · dev-only 페이지 4개 (/f4-panels /f5-inbox /f6-portfolio /f8-paper) + tests/browser 대응 spec
  · research-assistant 모듈 전체 (445줄)
  · Alpaca 일체 — .env.example 5줄 + runtime-policy 스키마.
    테스트의 "alpaca" 는 임의 provider 식별자 → "kis" 로 교체 (중복되면 "synthetic")
  · 미사용 env 5개: GEMINI_API_KEY · KRX_API_KEY · MAILPIT_API_BASE_URL · MAILPIT_UI_URL · KIS_ENVIRONMENT
    (src/ · scripts/ · compose.yaml 참조 0건 실측 확인됨)

Stage 2 — 영속성 + 모듈 정리
  T1. FencedKeyedStore → platform/ 으로 이동 (인터페이스 유지, 이동만)
  T2-a. compose.yaml 에 postgres named volume 추가 (인프라 영속성)  ← T2-b보다 먼저
  T2-b. Postgres 구현체 + paper 원장/outbox 테이블 마이그레이션      ← 최우선, 타협 불가
  T3. notification-center 삭제 (T1·T2 후에는 아무도 안 씀)
  T4. actual-portfolio: calculation/ 만 남기고 broker-sync/·baseline/ 삭제

Stage 3 — A 컷: 웹·인증 제거 (Stage 2 완료 + CLI 골격이 선 뒤에 실행)
  · identity(1,446) · provider-connections(606) · auth/signin 라우트 · terminal-view(2,747)
  · credential-vault(234)는 남긴다 — CLI 브로커 키 암호화 저장에 필요 (§3-16)
  · 게스트 시세 터미널(/) 존치 여부를 이 시점에 결정 — 기본 배포는 npm publish,
    웹 데모는 배포 운영 비용(호스트+PG+Redis)을 감수할 때만
  · Stage 3 직후 문서 재정합: map.md Destination·spec.md 를 남은 시스템 기준으로 재작성,
    T8~T12 를 정식 티켓(42~)으로 작성, README 재작성(§9-4)

이후 — 엔진
  T8. 백테스트 엔진 — InternalPaperSimulator 를 과거 캔들로 확장 + 시간축 커서(look-ahead 차단)
  T9. 성과 리포트 — F7 TWR/XIRR 재사용 + MDD·승률 + 체결 신뢰도 집계
  T10. 전략 정의 층 + CLI + MCP  (선행 티켓 초안 있음: .scratch/financial-terminal/issues/40·41)
  T11. 실시간 모의투자 — 같은 엔진에 실시간 피드 연결
  T12. 호가 수집기 (돌리기 시작한 시점부터 정밀 모드 데이터가 쌓임)

규칙: 각 Stage 끝마다 4개 게이트(typecheck·lint·test·build) + 커밋. 자르기 전마다 git tag.
     테스트 개수가 삭제 모듈만큼 줄어드는 것은 정상 — 삭제 전/후 개수를 함께 기록할 것.
     각 Stage 커밋에는 .scratch/financial-terminal/map.md "트랙 상태" 한 줄 갱신을 포함한다.
     map.md·spec.md 상단에 supersede 배너 있음(2026-07-22) — 옛 Destination·이월 백로그를 따르지 말 것.
     스펙·맵 전면 재작성은 Stage 3 뒤 (지울 코드의 스펙을 미리 고쳐 쓰는 낭비 방지 + 게스트 터미널 미결).
```

**T2가 절대 먼저다.** 재시작하면 날아가는 원장 위에 백테스트를 얹는 건 말이 안 된다.
다만 `FencedKeyedStore`가 이미 seam이라 **재설계가 아니라 구현체 추가**다.

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
| `src/platform/delivery/delivery-aad.ts:33` | `"fakebloomberg/delivery-vault/v1"` | 동일 |
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
