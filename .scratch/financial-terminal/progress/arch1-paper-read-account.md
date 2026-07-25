# arch-1 — Paper account 읽기를 module 안으로 (read-only seam)

상태: **완료** (2026-07-26). Owner: main(Opus 5). Claimed: 2026-07-26. Heartbeat: 2026-07-26 커밋 시점.
게이트: typecheck 0 · lint 0 error(경고 1, 기존) · **767 통과 / 56 skip** · public/server seam 2종 · build 미실행(코드 경로 변경만, Next 라우트 무관).
**미검증 1건**: `paper open` 의 `created` 판정은 PG 레인에만 커버가 있고 그 레인을 이번 세션에 못 돌렸다 — 이월 3 참조.

출처: 2026-07-26 `/improve-codebase-architecture` 아키텍처 리뷰의 후보 1 (Strong).
설계는 `/grilling` 6문답으로 확정 — 아래 "확정된 설계" 절이 그 결과다.

## Blast radius / 검증 tier 선언 (AGENTS.md 하한 — 착수 전 필수 절)

- **Tier: 최상위** — `src/modules/paper-trading/` 를 건드린다. tier-gate(`scripts/gates/tier-gate.sh:25`)의
  guarded 경로이며 collaboration.md tier 표의 자동 승격 대상이다. 변경 자체는 read-only 메서드 추가지만
  `paper open` 의 genesis 여부 판정(`created`) 로직이 함께 바뀌므로 "읽기 전용이라 waive" 는 성립하지 않는다.
- **요구 게이트**: blind test-authorship(별도 에이전트가 구현 미열람, 계약만 보고 작성) +
  적대 리뷰 + Standards 축 code-review 1패스.
- **⚠️ 적대 리뷰는 차선책으로 진행** (2026-07-26, 사용자 결정): 전역 규칙은 원 작성자와 **다른 계열 모델**
  (Claude 산출물 → codex)을 요구하나 이 세션 시점에 codex 토큰이 없다. 차선으로 **관점·프레이밍·근거 범위를
  어긋낸 별도 Claude 에이전트**를 쓴다. 규칙이 요구하는 대로 **차선이었음을 여기와 커밋 트레일러에 남긴다.**
  codex 가용해지면 이 변경을 재타격 대상 목록에 올릴 것.
- **커밋 트레일러**: `Tier: top (adversarial=이 문서, blind=이 문서, standards=이 문서)`
- **Contain**: 변경 파일 4개. 원장 fold·simulator·journal store 는 건드리지 않는다 —
  새 메서드는 기존 `journal.state()` 읽기를 조립할 뿐 append 경로에 닿지 않는다.
  마이그레이션 없음. 프로덕션 소비자는 CLI `paper account`/`paper open` 과 MCP `call_operation`.

## 문제 (리뷰에서 실측된 것)

`PaperTradingService` 의 interface 에 **provision 하지 않는 계좌 읽기**가 없다. 유일한 문인 `open()`
(`service.ts:214`)은 `journal.provision` 을 호출한다. 그래서 읽기 호출자가 우회한다:

- `src/operations/catalog.ts:216-235` — `createDurablePaperTrading({seedCash: []})` 로 **가짜 정책을 주입해
  genesis 능력을 무력화**한 뒤 `journal.init()` → `defaultPaperAccount()` → `journal.ownerOf()` →
  `journal.state()` → `presentState()` 5단계를 손으로 조립. 주석(220-221)이 그 우회를 자백한다.
- `src/cli/commands.ts:277-279` — 같은 `init` + `defaultPaperAccount` + `ownerOf` 를 `created` 판정용으로 재조립.

`PaperTradingService` 는 `#ready` 하이드레이션을 자기 메서드마다 await 하며(`service.ts:135-143`),
그 주석은 이걸 빼먹으면 "durable store 위의 service 가 빈 캐시로 소유권을 판정해 자기 영속 계좌를 거절한다"
(codex T2-b 발견)고 기록한다. journal 직행 호출자는 그 순서 의무를 손으로 되짊어진 상태였다.

**정정 (리뷰 보고서 대비)**: 리뷰는 "호출자 3"이라 했으나 `backtest-runner.ts` 는
`src/modules/paper-trading/backtest/` — **같은 module 안**이라 seam 을 넘지 않는다. 실제 외부 호출자는 2다.

## 확정된 설계 (grilling 6문답)

1. **대상**: 빠진 read-only 메서드 하나. `open()` 을 provision/read 로 쪼개는 안은 기각 —
   현재 `open()` 호출자 중 하나(terminal-view)가 Stage 3 에서 삭제되므로 곧 사라질 호출자에 맞춰 설계하게 된다.
   journal 직행 경로를 막는 안도 기각 — journal 은 의도적 public surface이고(`tests/f8-journal-boundary.test.ts:15-16`)
   백테스트 러너가 그 위에 선다. 그건 후보 3(`index.ts` seam 선언)의 일이다.
2. **시그니처**: `readAccount(viewer: ViewerContext)` — `prepare`/`change`/`open` 과 동일하게 인가를 지난다.
   workspace 문자열을 직접 받는 안은 기각: "쓰기 못 하는 메서드만 인가를 건너뛴다"는 예외는 읽는 사람이
   매번 왜인지 다시 유도해야 하는 interface 지식이 된다. T11 다중 워크스페이스 표면에서 조용한 구멍이 된다.
3. **반환**: `{status:"ready", account, cash, positions, orders} | {status:"absent"} | {status:"denied"}`.
   저장소 오류는 계속 throw — 표면의 try/catch(SEC-05)가 `unavailable` 로 옮긴다. 네 번째 arm 을 두면
   이 메서드만 다른 규칙을 갖는다.
   - `absent` 를 기존 `refused/unknown_account` 로 접는 안은 기각: 이 module 에서 `refused` 는 "명령이 거절됐다"
     이고, 읽기가 계좌를 못 찾은 건 거절이 아니라 정직한 답이다. `CONTEXT.md` 의 **Information Outcome** 이
     이미 이 선을 긋는다 — `unavailable`(데이터 없음)은 실패가 아니라 값 없는 성공이다.
   - `Snapshot | undefined` 안은 기각: "계좌 없음"과 "볼 권한 없음"이 같은 `undefined` 로 접힌다.
4. **사거리**: 넓게 — catalog + commands 둘 다 교체. 그러면 `defaultPaperAccount`/`presentState` 가
   module 밖에서 사라지고 외부 표면이 `PaperTradingService` 하나로 줄어, 후보 3(`index.ts`)이
   설계 작업이 아니라 받아쓰기가 된다. tier-gate 비용은 좁게 가도 동일하므로 추가 대가가 없다.
5. **`seedCash: []` 거짓말**: 그대로 두고 주석만 사실 진술로 교체. `readAccount` 가 생기면 catalog 은
   `open()` 을 아예 안 부르므로 그 값이 더는 짐을 지지 않는다. `createPaperReader` 전용 조립을 두는 안은
   구현체 하나짜리 interface라 기각 — 두 번째 읽기 표면(T11)이 생기면 그때 진짜 seam 이 된다.
6. **검증**: 3축 전부 실행 (blind 는 계약이 3-arm 유니온 하나라 유난히 싸다).

## 변경 파일 (4)

| 파일 | 변경 |
|---|---|
| `src/modules/paper-trading/internal/service.ts` | `readAccount` 추가. `defaultPaperAccount` export 회수 + 낡은 주석 삭제. `presentState` 는 backtest-runner(같은 module)용으로 export 유지 |
| `src/composition/paper-assembly.ts` | `cliViewer()` 를 `CLI_WORKSPACE` 옆으로 이전·export (표면 신원의 단일 정의) |
| `src/operations/catalog.ts` | `paper.account` 5단계 → `readAccount` 1회. `seedCash: []` 주석 교체 |
| `src/cli/commands.ts` | `existed` 를 `readAccount` 로 판정. 계좌 문자열은 `open()` shell 에서. `defaultPaperAccount` import 제거 |

**← 범위 확대 (적대 리뷰 반영, 2026-07-26). 위 표는 착수 시 선언이고 실제는 아래가 더해졌다:**

| 파일 | 추가된 변경 | 왜 |
|---|---|---|
| `src/composition/paper-assembly.ts` | epoch 단일 상수화 + **identity 포트를 `CLI_WORKSPACE` 로 한정** | 1라운드: 이 조립의 service 는 epoch 만 맞으면 임의 workspace 를 인가했고, arch-1 이 거기에 원장 내용을 반환하는 첫 read 문을 얹었다 (사용자 결정 B) |
| `src/modules/paper-trading/internal/service.ts` | `identity.currentAuthorizationEpoch` 반환을 `string \| undefined` 로 (거부 채널 도입) | 2라운드: 거부를 "다른 epoch 문자열" 로 인코딩하면 **추측 가능한 매직 스트링**이 된다. red-team 이 그 값을 든 뷰어로 임의 workspace 를 읽고 genesis 까지 뚫었다. **방어의 실체는 타입이다** — `#authorized` 의 `undefined` 조기 반환은 명시일 뿐 런타임 무동작이고(비교의 우변이 언제나 string), 실제 거부는 조립의 포트 한정이 낸다 (Spec 축 지적, 정정 반영) |
| `src/modules/paper-trading/internal/service.ts` | `presentState` 가 clone + freeze 후 반환 | 2라운드: 투영이 원장의 살아있는 payload/fills 를 넘긴다. durable 경로는 `deepFreeze` 를 안 거친 재파싱 JSONB 다 |
| `src/modules/paper-trading/internal/journal.ts` | `deepFreeze` export + **거짓 주석 정정** | 옛 주석이 "PG 스토어는 JSONB 를 재파싱하므로 이미 immutable" 이라 주장했다. 거짓이고, `open()` 이 무방비로 남은 근거였다 |
| `src/modules/paper-trading/backtest/backtest-runner.ts` | 지역 clone 유지 + 이유 재서술 | 이제 원장 격리는 `presentState` 몫이다. 이 clone 은 **다른 이유**로 남는다 — 전략은 신뢰할 수 없는 코드라 동결된 뷰에 stray write 하면 TypeError 로 런이 죽는다 |

## 적대 리뷰 기록

**⚠️ 차선책이었다** — 전역 규칙은 원 작성자와 다른 계열 모델(codex)을 요구하나 codex 토큰이 없어
`adversarial-review` 스킬(red-team → arbiter → 반영 → 재실행)로 대체했다. **같은 계열 모델이라는 한계는 남는다.**
codex 가용해지면 이 변경을 재타격 대상에 올릴 것.

- **1라운드** (관점 5: 계약정합·정보누출·동시성·표면회귀·검증적정성)
  - **Blocker 1** — blind PG 케이스가 `operationCatalog()` 를 deps 없이 불러 PG 를 켜도 무조건 실패.
    나는 그 직전에 그 파일을 `test:persistence-pg` 에 등록했으므로 빨간 게이트를 출하할 뻔했다.
  - **High 3** — 투영의 살아있는 객체 노출 / `owner !== workspace` 검사 누락(3개 축이 독립 발견) /
    blind PG 블록이 `paper-cli.pg.test.ts` 와 같은 테이블·계좌를 TRUNCATE
  - **Medium 3** — epoch 리터럴 2개 drift / `#staleCache` 미참조 / `commands.ts` 주석이 없는 원자성 주장
  - 기각: `#staleCache` 근본 수정(도달 불가 + `journal.ts` 로 범위 확대) · catch-all 라벨링(T8 기존 부채) ·
    `PaperTradingErasure` 미등록(기존 부채) · Stryker 범위(아키텍처 리뷰 별건)
- **2라운드** (수정분 자체를 공격)
  - **High 1** — 1라운드 수정으로 도입한 `NOT_THIS_SURFACE` 가 추측 가능한 인가 토큰. 실제로 뚫림
  - **Medium 2** — clone 이 4개 호출자 중 1개에만 적용 / `journal.ts` 의 거짓 주석
  - **High(게이트) 3** — 새 동작 3종(workspace 한정 인가·투영 격리·소유권 검사)이 **전부 무검증**.
    제거/되돌려도 18/18 통과 → blind 저자에게 SPEC 8·9·10 으로 반송
  - **정정 채택**: blind 저자가 PG 블록 삭제 사유로 든 "vitest 에서 파일 간 순서 강제 불가" 는 **거짓**이다
    (`--no-file-parallelism` 존재). 다만 그 블록은 애초에 `test:persistence-pg` 파일 목록 밖이라
    **어떤 레인에서도 실행된 적이 없었다** — 삭제 결론 자체는 유지하되 사유를 이 줄로 정정한다.

## 이월 (이 티켓에서 안 고친 것)

1. **`readAccount` 의 freshness 는 first-hydration 한정.** `#ready` 는 생성자의 1회 `init()` 이고
   journal 의 캐시 재구축(`#ensureFresh`)은 mutation 경로에서만 돈다. 장수 service 가 genesis 경합에서
   지면 stale fold 로 계속 답한다. **오늘 두 표면은 호출마다 새 service 를 만들고 변이 전에 읽으므로 도달 불가.**
   MCP 가 service 를 재사용하는 순간(자연스러운 다음 최적화) High 가 된다 — `PaperJournal` 에 public
   fresh-read 를 먼저 내야 한다. 별건 tier-top.
2. **`paper open` 의 read→open 은 원자적이지 않다.** 같은 DB 를 가리키는 CLI 두 개가 경합하면 진 쪽이
   `created:true, cash:[]` 를 exit 0 으로 보고한다(원장은 멀쩡, 출력만 거짓). 단일 소유자는 관습이지
   스토어가 강제하는 불변식이 아니다. 제대로 고치려면 `open()` 이 genesis 결과를 돌려줘야 한다.
3. **`created` 판정에 실행되는 검증이 0개.** 유일한 커버리지 `paper-cli.pg.test.ts` 가 PG 게이트 뒤인데
   **로컬 postgres 컨테이너(`fb-pg`)가 이름 변경 전 role(`fakebloomberg`)을 갖고 있어 이 저장소의
   PG 레인은 현재 누구도 돌릴 수 없다** (피벗 메모 §7 이 예고한 볼륨 재생성 미실행). arch-1 과 무관한 기존 문제.
4. **`paper.account` 오퍼레이션의 `positions`/`orders` 를 durable 경로에서 읽는 테스트가 저장소에 없다.**
   `paper-cli.pg.test.ts` 는 `exists`/`cash` 만 본다. clone+freeze 가 방어한다고 선언한 바로 그 상태다.
5. **기존 3자 TRUNCATE 레이스** — `paper-cli.pg.test.ts` · `paper-journal.pg.test.ts` ·
   `money-conservation.property.test.ts` 가 같은 5개 테이블을 병렬로 TRUNCATE 한다.
   `test:persistence-pg` 에 `--no-file-parallelism` 한 단어면 해소된다. arch-1 이 만든 게 아니다.
6. **Stryker mutate 글롭에 이 파일들이 없다** — `runtime-policy.ts`·`network-policy.ts` 2개뿐이고
   CI·훅 어디에도 배선돼 있지 않다. 아키텍처 리뷰가 별도 후보로 잡았다.

## 도메인 용어 검토 (domain.md 요구)

`absent` 는 `CONTEXT.md` 의 **Information Outcome** 이 `unavailable` 한 통에 넣는 것(`데이터 없음` + `표시 권한 없음`)을
paper-trading 어휘에서 둘로 가른다. domain.md 가 요구하는 "같은 티켓에서 CONTEXT.md 변경 필요성 검토" 결과:

**변경하지 않는다.** `absent`/`denied` 는 한 module 메서드의 상태 arm 이지 도메인 개념이 아니고,
`Information Outcome` 은 **정보 요청(시세·공시)** 의 결과 어휘로 financial-information 이 소유한다.
다만 Standards 축 지적대로 `service.ts` docstring 이 CONTEXT.md 를 근거로 인용한 것은 과했다 —
CONTEXT.md:258 은 두 경우를 같은 `unavailable` 로 묶으므로, 그 인용은 "지지" 가 아니라 "의도적 분기" 로 읽어야 한다.
**T11 에서 두 번째 읽기 표면이 생기면 이 분기를 CONTEXT.md 에 정식 용어로 올릴지 재검토할 것.**

## 진행

- 착수 문서 작성 → blind 계약 전달 → RED 확인(16 fail) → 구현 → GREEN
- 적대 리뷰 1라운드(5축) → 채택분 반영 → 게이트 green
- 적대 리뷰 2라운드(3축) → 채택분 반영 → 게이트 green (759 통과 / 56 skip)
- blind SPEC 8·9·10 완료 — 26케이스(18+8), 위반 0. 게이트 green (767 통과 / 56 skip)
- Standards + Spec 2축 리뷰 → 채택분 반영:
  - `catalog.ts` 의 낡은 주석(포트 한정 후 "epoch 은 상수" 근거가 거짓) 정정 — 두 축 모두 지적
  - `paper open` 의 denied 를 `crash`(exit 1) → `api`(exit 2) 로. 같은 조건이 `paper.account` 에서는
    exit 2 였다 — 적대 리뷰 1·2라운드도 각각 지적한 건이다
  - `#authorized` 의 `undefined` 조기 반환이 런타임 무동작임을 주석·문서에 명시(방어의 실체는 타입)
  - `presentState` 의 clone+freeze 비용 천장을 `ponytail:` 주석으로 명시 (백테스트는 바마다 호출)
  - 도메인 용어 검토 절 추가 (위)
- **미채택**: blind 파일의 케이스 번호 `8.`/`9.` 가 새 SPEC 8·9 와 충돌 — 라벨뿐이라 blind 저자 파일을
  구현자가 건드리지 않는 쪽을 택했다. 다음 blind 반송 때 함께 정리할 것
