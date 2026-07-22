# 한국어 금융 터미널 (`provenance`)

> **데이터 정직성(data honesty)을 1급 제약으로 설계한 Bloomberg 스타일 금융 터미널 MVP.**
> 값을 모르면 값을 만들어내지 않는다 — 표시할 수 없는 데이터는 숫자 대신 *왜 없는지*를 보여준다.

TypeScript 모듈형 모놀리스 · Next.js 16 · PostgreSQL · Redis · 비동기 워커로 구현했으며,
비로그인 공개 조회, 로그인 사용자별 포트폴리오·설정, 커스터마이징 가능한 고밀도 터미널 UI,
Paper Trading, 안전한 브로커 연결 구조를 포함한다. 외부 데이터 예산은 **USD 0** — 무료·공개
라이선스 소스만, 그것도 라이선스가 허용하는 화면·사용자에게만 사용한다.

---

## 왜 이 프로젝트인가

금융 데이터 UI에서 가장 위험한 실패는 "그럴듯한 거짓 숫자"다. 지연된 값을 실시간처럼,
장 마감 후 전일 종가를 현재가처럼, 개인 계정으로 받은 데이터를 공개 서비스처럼 보여주는 순간
사용자는 잘못된 판단을 한다. 이 프로젝트는 **그 실패를 타입·계약·불변식으로 구조적으로
불가능하게 만드는 것**을 목표로 삼았다.

핵심 질문은 "무엇을 보여줄까"가 아니라 **"이 값을 보여줄 권리와 근거가 있는가"** 다.

---

## 핵심 설계: 데이터 정직성 모델

모든 시장 정보는 세 가지 축을 함께 운반한다.

| 축 | 값 | 의미 |
|---|---|---|
| **Information Outcome** | `available` / `unavailable` / `failed` | 값은 오직 `available`에만 존재. 나머지는 `api_required`·`license_restricted`·`no_data`·공급자 실패로 *이유*를 표시 |
| **License Scope** | `public` / `personal` / `internal_test_only` | 데이터를 누구에게 보여줄 권리가 있는가. `personal`은 절대 공개 feed로 재배포되지 않는다 |
| **Data Freshness** | `realtime` / `delayed` / `stale` | 출처·기준 시각(as-of)과 함께, 값이 얼마나 신선한지 정직하게 노출 |

> 예: 장 마감 후 KIS 시세를 조회하면 위젯은 전일 종가를 `stale · eod`로 표기한다.
> 개장 시간(09:00–15:30 KST)에만 `realtime · trade`가 되며, **휴장일(설날·추석·대체공휴일·
> 지방선거·연말 폐장)에는 실시간으로 위장하지 않는다.**

---

## 아키텍처

**Ports & Adapters** 기반 모듈형 모놀리스. 각 도메인 모듈은 공개 인터페이스(port)만 노출하고,
조합 계층(`src/composition`)이 런타임 정책에 따라 어댑터를 조립한다.

```
src/
├── app/               Next.js App Router (라우트 · 터미널 UI · 위젯)
├── modules/           도메인 모듈 (단일 컨텍스트)
│   ├── financial-information/   시장·뉴스·공시·차트 정보 + InformationOutcome 정규화
│   ├── identity/               세션·계정·워크스페이스 (hash-only, fence-first erasure)
│   ├── provider-connections/   사용자별 Provider Credential (AES-256-GCM)
│   ├── actual-portfolio/       읽기 전용 실계좌 스냅샷
│   ├── paper-trading/          내부 Paper 원장 (돈의 유일 변경 경계)
│   ├── research-assistant/     source-owned AI envelope (라이선스·redaction 백스톱)
│   ├── notification-center/    인앱 알림 정본 + 외부 전달
│   └── terminal-view/          위젯·패널을 조합하는 뷰 계층
├── composition/       런타임 정책 · 싱글턴 조립 · 크리덴셜 게이팅
├── platform/          런타임 의존성 (DB 풀 등)
├── shared/            공유 계약 (InformationOutcome · brands · viewer-context)
└── worker/            비동기 워커
```

### 두 데이터 트랙 — 재배포 경계

라이선스가 다르면 대상 사용자도 다르다. 이 경계는 코드로 강제된다.

- **개인용 (KIS 한국투자증권 · `personal`)** — 로그인한 owner 본인에게만. 개인 API 키로 받은
  국내주식 시세를 workspace 위젯에 표시. `personal` 라이선스는 owner 외 조회 시 `api_required`로
  차단되며 **공개 feed·다른 사용자 캐시로 절대 재배포되지 않는다.**
- **게스트용 (공개 정본 · `public`)** — 비로그인 누구나. 재배포가 명확히 허용된 public-domain
  소스(미 재무부·ECB·SEC EDGAR·Open DART 등)만 공개 터미널에 배선. *(어댑터 배선 진행 중)*

---

## 안전 불변식 (Standing Invariants)

틀리면 비싼 경로는 단위 테스트를 넘어 **상시 property로 검증**한다. 아래 네 불변식은
`fast-check` 기반 standing property로 CI에 상시 편입되어 있으며, 그중 최상위 안전 모듈 2개는
**Stryker mutation testing**으로 "가드를 물리적으로 부수면 테스트가 죽는지"까지 실증한다.

| 불변식 | 강제 내용 |
|---|---|
| **No Live Trading** | 초기 산출물은 실제 브로커로 주문을 전송하지 않는다. Paper 경로만 실행 |
| **No Redistribution / Egress** | 개인 키 데이터가 공개 feed로 새지 않는다. 외부 전송 목적지는 허용목록으로 pin |
| **Money Conservation** | append-only 원장 fold에서 돈은 생성·소멸하지 않는다 (§8 trio) |
| **Actual / Paper Isolation** | 실계좌 원장과 Paper 원장은 서로의 상태를 오염시키지 않는다 |

---

## 검증 전략

- **Network-off 결정론 TDD** — 모든 단위·통합 테스트는 네트워크 없이 결정론적으로 돈다.
  외부 공급자는 저수준 HTTP 주입(seam)으로 대체하고, 실제 API는 **opt-in contract test**로 분리.
- **Contract tests** — 실 KIS 등 외부 API 계약은 환경변수 게이트(`KIS_CONTRACT=1`)로만 실행.
- **Property + Mutation** — `fast-check`(불변식 property) + `@stryker-mutator`(가드 kill 실증).
- **적대적 리뷰** — 고위험 산출물(크리덴셜·돈·인증 경로)은 구현과 다른 프레이밍의 blind 검수와
  독립적인 test-authorship로 반례를 찾고, 직접 근거가 확인된 지적만 수정.
- **Browser / A11y** — Playwright + `@axe-core/playwright`로 실 DOM·접근성·성능 예산 검증.
- **CI parity** — 로컬 pre-commit 훅과 동일한 게이트를 GitHub Actions에서 원격 강제.

```bash
npm run check            # typecheck + lint + test (+ public/server seam)
npm run test:mutation    # Stryker (no-live · egress 모듈)
npm run verify:network-off
npm run test:persistence-pg
```

---

## 에이전트 운영 모델

이 저장소는 에이전트에게 기능 구현만 맡기지 않고 **작업 선택 → 소유권 → 검증 → 통합** 루프도 저장소 안에서 관리한다. 도구별 진입점은 짧게 유지하고, 프로젝트 상태와 안전 규칙은 모든 에이전트가 공유하는 Markdown 정본에 둔다.

```text
dependency map → frontier claim → single-file ownership
               → implementation → deterministic gates
               → adversarial review → resolve or human gate
```

- [공통 하한](./AGENTS.md): dirty worktree 보존, 단일 파일 owner, allowlist staging, 비밀·외부 실행 제한
- [로컬 티켓 루프](./docs/agents/issue-tracker.md): dependency-aware frontier, claim, heartbeat, 검증 증거와 resolve
- [협업·검수 등급](./docs/agents/collaboration.md): Prevent → Detect → Contain, blast-radius 기반 검증, 고위험 경로의 사람 게이트
- [하네스 사례 연구](./docs/notes/harness-and-loop-engineering.md): 일회성 다중 검수를 property·mutation·network-off 상시 검증으로 바꾼 과정
- [릴리스 게이트](./docs/release/release.md): credential pattern, `.scratch/`와 미분류 파일을 fail-closed로 차단하는 재현 가능한 패키징

`.scratch/`는 스펙·티켓·중간 가설을 포함하는 작업 정본이다. 포트폴리오 설명은 위의 정제된 문서를 기준으로 하고, 현재 사실 여부는 코드·테스트와 `resolved` 티켓의 검증 결과로 확인한다.

---

## 보안

- **크리덴셜 원문은 어디에도 평문 금지** — 코드·문서·설정·권한 allowlist 어디에도. 서버 환경변수
  또는 **AES-256-GCM 암호화 저장소**에만 둔다. 사용자별 키는 마스킹되어 저장·조회된다.
- **Hash-only 세션** — 불투명 세션 프루프. generation·authorization epoch·deletion fence로
  탈취·재사용·권한 이탈을 봉쇄.
- **Fence-first erasure (SEC-09)** — 삭제는 fence를 먼저 세운 뒤 한 트랜잭션으로 원자 수행,
  잔류 PII 표면을 100% 커버.
- **Enumeration-safe 로그인** — 이메일 챌린지는 계정 존재 여부를 누설하지 않는다.

---

## 기술 스택

| 영역 | 사용 |
|---|---|
| 언어·런타임 | TypeScript, Node.js |
| 웹 | Next.js 16 (App Router, Turbopack), React 19 |
| 데이터 | PostgreSQL (`pg`), Redis |
| 검증 | zod (런타임 스키마) |
| 테스트 | Vitest, fast-check, Stryker, Playwright, axe-core |
| 인프라 | Docker Compose, GitHub Actions, Husky |

---

## 실행

### 1) 네트워크-오프 개발 (기본)

```bash
npm install
npm run dev            # http://localhost:3000 — scripted 공급자 (실 API 불필요)
```

### 2) 풀 스택 (Docker: app + PostgreSQL + Redis)

```bash
npm run compose:up     # 마이그레이션 포함 기동
npm run compose:down
```

### 3) 실 KIS 개인용 데이터 (single_owner)

로컬 PostgreSQL + 마이그레이션 후, `.env.local`에 `KIS_APP_KEY` / `KIS_APP_SECRET`(개인 키)를
두고 아래 환경으로 부팅한다. **비밀은 파일에만, 코드/로그에는 절대 노출하지 않는다.**

```bash
export DATABASE_URL="postgresql://…"
npm run db:migrate

APP_ENVIRONMENT=development \
IDENTITY_PERSISTENCE=postgres \
LOCAL_PROVIDER_CREDENTIAL_MODE=single_owner \
LOCAL_PROVIDER_OWNER_WORKSPACE_ID=<owner workspace id> \
RUN_KIS_PAPER_READ_CONTRACT=true \
npm run dev
```

로그인 owner의 workspace 위젯에서 실 KIS 국내주식 시세가 freshness·출처와 함께 렌더된다.
(장 마감 시간대에는 전일 종가가 `stale · eod`로 정직하게 표기된다.)

---

## 프로젝트 상태 (정직한 로드맵)

이 저장소는 승인된 MVP 스펙(F0–F11)을 기준으로 티켓 단위로 구현·검증한다.

| 스파인 | 내용 | 상태 |
|---|---|---|
| **F0** | 기반·공유 계약·AES-256-GCM vault·조합 harness | ✅ |
| **F1** | 비로그인 터미널 shell (공개 outcome만) | ✅ |
| **F2** | 차트 tracer (OHLCV·지표·freshness) | ✅ |
| **F3** | Identity·Provider Connections·workspace 레이아웃 | ✅ |
| **F4** | 정보 outcome·source-owned AI tracer | ✅ |
| **F5** | 알림·외부 전달 tracer | ✅ |
| **F6** | Actual Portfolio 베이스라인 (읽기 전용 동기화) | ✅ |
| **F7** | 포트폴리오 회계 (TWR·XIRR·P&L 분해) | ✅ |
| **F8** | 내부 Paper Trading (append-only 원장) | ✅ |
| **F9** | Broker Paper 실행 (durable outbox·exactly-once) | ✅ |
| **F10** | Broker Sync (read-only, complete-snapshot 승격) | ✅ |
| **F11** | 릴리스 통합 (Docker·ZIP·문서·스크린샷·load) | 🔶 배포 환경 게이트 대기 |
| — | Persistence seam(pg 이관)·불변식 property/mutation·CI parity | ✅ |
| — | **실 KIS 개인용 시세** 어댑터 + 배선 (첫 실 공급자, end-to-end 라이브 스모크 확인) | ✅ |
| — | 게스트 공개 실데이터 트랙 (소스 확정 → 어댑터 배선) | 🔶 진행 중 |

- **Paper Trading은 완전 구현**, **Live Trading 주문 전송은 의도적으로 비활성**.
- 실시간 스트리밍(SSE/WS)·해외/선물·per-user KIS 키·임시공휴일 캘린더는 이월 backlog.

---

## 면책

- 초기 산출물은 실제 브로커로 **Live Trading 주문을 전송하지 않는다**.
- 이 프로젝트는 학습·포트폴리오 목적이며, 어떤 화면·수치도 **투자자문이 아니다**.
- 외부 데이터는 각 공급자의 라이선스가 허용하는 범위에서만 사용한다.
