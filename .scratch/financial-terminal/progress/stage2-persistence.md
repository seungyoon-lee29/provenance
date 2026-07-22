# Stage 2 — 영속성 + 모듈 정리 (T1 · T2-a · T2-b) 실행 기록

정본 계획: [pivot 메모 §6](../../../docs/notes/2026-07-22-pivot-backtest-strategy-engine.md).
Stage 작업은 Stage 1 선례대로 번호 티켓을 만들지 않고 map.md "트랙 상태" + 이 기록으로 남긴다
(번호 42~는 메모대로 Stage 3 뒤 T8~T12에 예약).

## Answer

**T1 — FencedKeyedStore 이동 (커밋 79a3abb).** 기판(`SubjectFence`·`Erasable`·`FencedKeyedStore`)을
`src/platform/persistence/fenced-store.ts`로 이동. 인터페이스 불변, 이동만. `notification-center/fenced-store.ts`에는
모듈 소유물인 `notificationErasureParticipant`만 남기고 내부 소비자용 재수출을 뒀다(T3에서 모듈째 삭제될 때 함께 사라짐).
목적: T3가 notification-center를 지울 때 생존 모듈(paper-trading·actual-portfolio)이 기판을 잃지 않게 하는 것.

**T2-a — postgres named volume (커밋 83d0003).** compose의 postgres에 볼륨 마운트가 없어 데이터가 컨테이너
레이어에만 있었다. `postgres-data` named volume + 최상위 `volumes:` 추가. `docker compose down` 한 번에
identity/세션/캐시가 사라지던 인프라 레이어 결함 봉쇄.

**T2-b — paper 원장 Postgres 영속화 + money-conservation 재수립.**
`PaperJournal`에 `PaperJournalStore` 포트를 넣었다. 읽기는 기존처럼 in-memory fold(동기), 쓰기는 **ack 전 durable**:
applied append는 store 커밋이 먼저고 그 다음 캐시 반영. append 1건 = 1 트랜잭션(entry + §8 receipt / exactly-once
system key + owner). 메모리 구현체가 오라클이자 기본값이라 기존 호출자의 **의미**는 바뀌지 않는다.

> **← 정정 (메모 전제 대비)**: pivot 메모 §6은 "`FencedKeyedStore`가 이미 seam이라 재설계가 아니라
> **구현체 추가**"를 전제했으나 **틀렸다**. 동기 KV 인터페이스로는 entry+receipt+system_key+owner를
> 한 트랜잭션으로 묶을 수 없어(=T2-b의 핵심 보증) 기존 seam에 끼우는 길이 없었다. 실제로는 **새 포트**
> (`PaperJournalStore`, `journal.ts:146`)를 도입하고 `FencedKeyedStore`를 **읽기용 캐시로 강등**했다
> (`journal.ts:369·375`). 이 쪽이 낫다 — 캐시와 durable 진실이 타입으로 갈려 hydration·fence 재심사가
> 명시적 단계가 됐고 pg가 메모리와 같은 계약 스위트를 통과한다. 대신 **작업량 추정이 어긋났다**:
> service·simulator·lifecycle·paper-erasure + f8 테스트 8파일에 async 리플이 났다. 상세는 메모 §6 T2 문단.

- 마이그레이션 `0005_paper_trading`: 5테이블(entry·receipt·system_key·owner·fence). 각 행에 `at_epoch`을 두어
  **hydration이 행마다 fence에 재심사** → stale backup이 되살린 행은 살아나지 못한다.
- `UNIQUE (workspace, account, revision)`: 두 writer가 같은 revision을 접으면 조용한 덮어쓰기 대신 큰 소리로 실패.
- fence-first TOCTOU는 `PgPersonalCache` 선례대로 fence row `SELECT … FOR UPDATE` 선행으로 봉쇄.
- **money-conservation property 재수립**(Stage 1 손실분 복원): 대상이 삭제된 `BrokerPaperBook`이 아니라 이제 유일한
  돈 경계인 journal fold 위에 다시 세웠다. 임의 op 시퀀스(submit/fill/cancel/expire/dividend)를 **실제 append 경로로**
  구동하고, raw entry 리스트에서 **독립 오라클**이 현금·포지션·파생 예약을 재계산한다. 4개 property:
  항등식 + fail-closed, exactly-once 리플레이, **재시작 보존**, split 보존.
- `scripts/backup-drill.ts`의 `ALL_TABLES`·fence 전방 병합에 paper 5테이블 추가 → 백업 게이트가 돈 원장을 본다.

## Changed files

T1: `src/platform/persistence/fenced-store.ts`(신규) · `src/modules/notification-center/fenced-store.ts` ·
actual-portfolio 7파일 · paper-trading 3파일 · 테스트 2파일 (import 경로).

T2-a: `compose.yaml`.

T2-b: `db/migrations/0005_paper_trading.{up,down}.sql`(신규) ·
`src/modules/paper-trading/internal/journal-store.pg.ts`(신규) ·
`src/modules/paper-trading/internal/{journal,service,simulator,lifecycle,paper-erasure}.ts` ·
`src/composition/identity-assembly.ts`(배선 의무 주석) · `scripts/backup-drill.ts` · `package.json`(persistence 레인) ·
`tests/persistence/paper-journal-{contract,memory,pg}`(신규) · `tests/property/money-conservation.property.test.ts`(재수립) ·
`tests/f8-*.test.ts` 8파일(async 리플 await 패치).

## Validation

- `npm run check`: **1,179 통과** / 47 skip (typecheck · lint 0 error · seam 2종). T1 시점 1,160 → T2-b 후 1,179.
- `npm run build`: green.
- **실 postgres**: `migration-smoke` green(up·재적용 멱등·down·재적용) ·
  `persistence-integration` **42/42 green**(계약 스위트가 메모리/pg 동일 통과) · `backup-drill` **2 시나리오 green**.
- **fix가 실제로 버그를 잡는지 실증 2건**(mutation kill):
  ① service hydration 수정을 임시 제거 → 재시작 계약 테스트가 `unknown_account`로 실패, 복원 후 통과.
  ② revision 충돌 가드(`#claimRevision`)를 임시 제거 → 패자의 append가 거절 대신 **조용히 성공**(덮어쓰기),
  복원 후 통과.

## Review

codex 적대 리뷰 1회(4축: crash-consistency / fence·erasure / §8·§9 회귀 / 오라클 유효성) → **BLOCK**.
확인된 실결함 수정, 반증된 것은 기각:

| 축 | 지적 | 조치 |
|---|---|---|
| fence | 지연된 **낮은** fence erase가 상위 epoch에 정당하게 쓰인 행을 삭제(현금 777 소멸) | store·journal 양쪽에서 `fence <= watermark`면 no-op(`PaperEraseOutcome.stale`). 계약 테스트 추가 |
| §8/§9 | 같은 account id를 두 workspace가 provision → 양쪽 다 seed cash 지급 | pg에서 owner 행을 **먼저** 적법 판정(PK insert로 직렬화, 패자는 `conflict`). 메모리도 동형. 계약 테스트 추가 |
| crash | store는 커밋됐는데 ack 유실 → 재시도가 `duplicate`를 받고 캐시가 영구히 빈 채로 남음 | `#staleCache` 플래그 → 다음 mutation이 store에서 캐시 재구축. receipt 충돌도 raw 제약 오류 대신 `duplicate`로 매핑 |
| crash | `load()`가 5테이블을 병렬 단발 쿼리로 읽어 서로 다른 커밋 지평을 볼 수 있음(entry 없는 receipt) | 한 `REPEATABLE READ READ ONLY` 트랜잭션으로 통일 |
| §8/§9 | 서비스가 journal을 hydrate하지 않아 재시작 후 자기 계좌를 `unknown_account`로 거절 | `#ready` hydration을 모든 공개 진입점이 대기. **실증 완료**(위 Validation) |
| §8/§9 | `refresh`가 `initial`보다 먼저 돌면 genesis 이전 상태를 관측 | 둘이 같은 provision promise를 공유 |
| 오라클 | command 경로가 server-only kind를 실어 **두 번째 genesis를 발행**(현금 100→200)해도 오라클이 축복 | `PaperCommandBody` 타입 + 런타임 backstop. 계약 테스트 추가 |
| 오라클 | 잘못된 `eventTime`이 `NaN`으로 파싱되어 모든 시간 가드를 통과, 취소된 주문에 체결이 착지 | `Date.parse` 유한성 검사 추가. 계약 테스트 추가 |
| 오라클 | 확정 취소된 단주 주문이 정당한 액면분할을 `fractional_result`로 거부 | fold의 `reserving()` 술어와 일치시킴. 계약 테스트 추가 |
| 오라클 | 메모리 store가 같은 revision을 조용히 덮어씀(pg는 UNIQUE로 막음) | 메모리도 revision 충돌 시 loud 실패. 계약 테스트 추가(후속 커밋) — 가드 제거 시 패자가 조용히 성공함을 실증 |

**기각/범위 밖으로 판정한 2건**: "프로덕션이 `PgPaperJournalStore`를 구성하지 않는다" / "`PaperTradingErasure`가
identity 컴포지션에 등록되지 않았다". 실측 결과 **paper-trading은 프로덕션 호출부가 0건**이다(pivot 메모 §5-③의
기존 사실 — F8은 도달 가능한 UI가 없다). 즉 T2-b가 만든 결함이 아니고, 배포된 DB에 paper 행이 생길 수 없어
오늘 놓칠 erasure 대상도 없다. 그리고 배선 대상인 웹/identity 컴포지션은 Stage 3에서 삭제된다 —
지금 배선하면 곧 지울 코드를 쓰는 것이다. 대신 ① `PaperTradingErasure.erase`가 `tx`를 받아 스레딩하도록 고쳐
**등록되는 순간 원자적으로 동작**하게 만들고 ② `identity-assembly.ts`에 등록 의무를 경고 주석으로 남겼다.
실 소비자(T8+ 백테스트/CLI)가 붙을 때 등록이 필수다 — 아래 잔여 위험에 명시.

## Residual risks

- **배선 미완(의도)**: `PgPaperJournalStore`·`PaperTradingErasure`를 실제로 조립하는 것은 T8+ 소비자의 몫.
  그때 **erasure participant 등록이 필수**(같은 pool, `tx` 스레딩). 미등록 시 SEC-09 구멍이 열린다.
- **단일 writer 전제**: 프로세스가 여럿이면 revision UNIQUE가 예외로 터진다(조용한 손상 대신 큰 소리로 실패하도록
  택한 것). 다중 writer가 필요해지면 account 단위 durable CAS가 선행돼야 한다.
- **intent 참조가 재시작을 가로질러 충돌할 수 있다 (T2-b가 새로 도달 가능하게 만든 경로)**:
  `service.ts:112`의 `#intents`는 여전히 휘발성 `FencedKeyedStore`인데 참조가
  `paper-intent:{workspace}:{카운터}`이고 `#intentCounter`는 **프로세스마다 1부터 재시작**한다(`service.ts:143-147`).
  T2-b 이후 원장은 재시작을 살아남으므로, 재시작 전 참조를 들고 있던 호출자가 재시작 후 새로 발급된 **다른 intent**에
  매칭될 수 있다. 제출 payload는 저장된 record에서 나오므로(`#decideSubmit`) 의도하지 않은 주문 payload가 실행되는 형태다.
  **심각도 낮음** — 소비자 0건, 같은 workspace 한정, 돈 경계(journal) 자체는 아니며 auth epoch·account revision
  재검사가 상당수를 걸러낸다. **해소는 T8+ 소비자 배선 시점**: 참조를 카운터 대신 UUID로 바꾸거나 intent도 durable로.
- `load()`가 전량 로드다(`ponytail:` 표기). workspace 단위 페이징은 규모가 요구할 때.
- 메모리 store는 프로세스와 함께 죽는다 — 테스트·백테스트용이며 그게 의도다.
- notification-center·actual-portfolio의 원장은 여전히 in-memory. T3·T4에서 삭제 예정이라 영속화하지 않았다.
