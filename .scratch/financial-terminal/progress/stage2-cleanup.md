# Stage 2 — 모듈 정리 (T3 · T4) 실행 기록

정본 계획: [pivot 메모 §6](../../../docs/notes/2026-07-22-pivot-backtest-strategy-engine.md).
선행: [stage2-persistence.md](./stage2-persistence.md) (T1·T2). Stage 작업은 번호 티켓 없이
map.md "트랙 상태" + 이 기록으로 남긴다.

## Answer

**T3 — notification-center 삭제.** 워커가 아무것도 안 돌려 도달 UI가 0인 죽은 모듈(src 2,262줄, 20파일).
T1에서 `FencedKeyedStore` 기판을 platform으로 이미 뺐으므로 앱 컴포지션에 남은 소비자가 0건임을 실측
(`grep` 결과 platform 주석 1건 = T1 이동 출처 표기뿐, 실 import 0). 함께 제거한 배선:
- `src/composition/local-delivery-keyring.ts` + `tests/local-delivery-keyring.test.ts`
- `runtime-policy.ts`의 `DELIVERY_*`·`EMAIL_*`·`MAILPIT_*` 스키마 필드 + `assertDeliveryPolicy` 함수·호출 +
  `RuntimeConfig` 출력 필드(deliveryKeyringProvider/deliveryLocalKeyringFile/emailDeliveryProvider)
- `bootstrap.ts`의 deliveryKeyring 조립·반환, `manifest.ts`의 emailDeliveryProviders, `index.ts` 재수출
- `tests/runtime-policy.test.ts`의 delivery 3블록 + manifest 기대값의 emailDeliveryProviders
- f5-* 테스트 23파일

> **인증 독립 실측(위험 지점)**: identity 이메일 로그인(`src/app/api/auth/email/*`)은 `identityServer`를
> 쓰고 delivery keyring/EMAIL_* 설정을 **읽지 않는다** — auth 경로 grep 0건으로 확인. 메모 §6 주장
> ("인메모리 outbox+peek, 무관")이 실측으로 성립. `credential-vault`(브로커 키 AES 저장)는 그대로 존치.

**T4 — actual-portfolio를 calculation/만 남기고 축소.** `baseline/`·`broker-sync/`·`journal/`(합 1,551줄) +
`provider-connections/read-transport/`(유일 소비자 = broker-sync/sync-worker) 삭제. src 소비자 0건 실측(앱에서 죽은 코드).

- **경계 결정(메모가 "이때 결정"으로 위임한 지점)**: calculation/의 corporate-actions·transfers·rebalancing 3개가
  baseline/journal 타입에 의존했다. **셋 다 순수 함수이고 백테스트 성과 리포트에 재사용 가치가 있어**(메모 §6 T4·T9의
  TWR/XIRR 재사용 논지) **삭제 대신 타입 이전**을 택했다. 새 `calculation/actual-refs.ts`에 3개 branded ref
  (Actual{Account,Instrument,Source}Reference) + position 데이터 형태(PositionRow·ValuedPositionRow·
  MissingValuation·PositionsSection) + PortfolioTransfer를 **verbatim 이전**(port·presentPositionsSection 함수는
  이전 안 함 — 삭제). 3개 파일 import를 `./actual-refs`로 repoint.
- `Money`(valuation)와 `ReportingMoney`(calculation/contracts)가 구조적으로 동일(`{amount,currency}`)이라 이전 클러스터의
  money 슬롯을 ReportingMoney로 통일(중복 money 타입 회피). rebalancing은 `.reportingValue`·`.total`만 읽어 무해.
- 테스트: baseline/broker-sync/journal 전용 f6·f7-accounting-journal·f10 전체 삭제. **surgery 2건** — f7-acceptance는
  섹션 8(AccountingJournal)만 제거하고 섹션 1–7(생존 함수 커버리지) 보존; f8-paper-erasure는 SEC-09 erasure 블록(순수
  paper) 유지하고 stateful Actual 원장에 의존하던 두 번째 describe(behavioral Actual↔Paper invariance) 제거 —
  subject(ActualPortfolioService 상태)가 삭제돼 성립 불가, 구조적 격리는 f6-actual-paper-isolation +
  actual-paper-isolation.property가 계속 강제. f7-rebalancing·f6-actual-paper-isolation은 import만 repoint.

## Changed files

T3: 삭제 24 테스트파일 + notification-center 20파일 + local-delivery-keyring 1 · 수정
`runtime-policy.ts`·`bootstrap.ts`·`manifest.ts`·`index.ts`·`runtime-policy.test.ts`.

T4: 삭제 baseline 6 + broker-sync 6 + journal 2 + read-transport 2 + 테스트 19파일 ·
신규 `calculation/actual-refs.ts` · 수정 `calculation/{corporate-actions,rebalancing,transfers}.ts` +
`f7-acceptance`·`f8-paper-erasure`·`f7-rebalancing`·`f6-actual-paper-isolation` 테스트.

codex 수정: 신규 `tests/f7-accounting-events.test.ts`(생존 커버리지 복원) · 수정
`docs/configuration/provider-credentials.md`·`playwright.config.ts`·`playwright.performance.config.ts`.

## Validation

- `npm run check`: typecheck 0 · lint 0 error(stryker.config 익명 export 경고 1 = 기존) ·
  **테스트 569 통과 / 47 skip / 0 fail** · public·server seam 2종 green.
  (초기 559 → codex Medium 수정으로 f7-accounting-events 10테스트 복원 후 569.)
- `npm run build`(next build): green, 15 라우트 정상(codex 수정은 test·docs·playwright-only 라 재빌드 불필요).
- 생존 돈 경로 테스트 명시 실행: f7-acceptance·f7-{performance,personal-return,rebalancing,reporting-pnl}·
  f6-actual-paper-isolation·f8-paper-erasure·actual-paper-isolation.property·money-conservation.property
  = **9파일 78테스트 green**.
- **테스트 수 감소 대조(메모 규칙: 삭제 전/후 기록)**: T2-b 후 1,179 → T3·T4 후 559. 삭제 파일의 it/test 케이스
  596 + surgery 제거 11 + `it.each` 확장분 ≈ 620 = 1,179 − 559. **무음 손실 없음, 전량 삭제분으로 설명됨.**

## Review

codex 적대 리뷰 1회(4개 안전 주장 공격: Money→ReportingMoney 타입 붕괴 / 인증 독립 / 커버리지 보존 /
dangling 참조). **주장 1·2는 반증 실패(성립)**, **3·4는 실결함으로 반증** → 확정 결함 3건:

| 심각도 | 지적 | 조치 |
|---|---|---|
| Medium | **f7-accounting-journal.test.ts 전체 삭제가 생존 함수 커버리지도 지웠다** — 파일명과 달리 transfers(classifyTransfer·computeScopeAwareReturn)·corporate-actions(resolveAccountingSeries·splitQuantityFactor)의 **성공 분기**(split_restated 동등·merger complete basis·delisting 절단·no-scope-break 위임)를 유일하게 검증. f7-acceptance는 거절 경로만 커버 | 삭제 파일에서 journal 부분만 제거하고 생존 3 describe를 `tests/f7-accounting-events.test.ts`로 복원(import repoint, unused 헬퍼 제거). **10테스트 복원**(569 = 559+10) |
| Low | **docs·playwright가 제거된 delivery 컨트롤을 기술** — `provider-credentials.md`가 Resend/Mailpit/keyring 검증을 문서화하나 runtime-policy가 필드를 지워 Zod가 조용히 strip → 운영자가 무효 설정을 성공으로 오인 | 문서의 delivery keyring/email/Web Push 문단을 "T3에서 제거됨" 안내로 대체(provider/identity/origin 내용 보존), playwright 2 config의 stale `DELIVERY_*`/`EMAIL_*` 주입 제거 |

**Stage 3로 이월한 지적(반증했으나 T3/T4 범위 밖)**: 아래 잔여 위험 참조.

- **주장 1(타입 붕괴) 성립**: `Money`↔`ReportingMoney`는 구조적 동일 readonly, 어떤 필드·optional·union 판별자도
  안 바뀜. wrong-currency 조합은 이전·이후 모두 동일하게 가능(변화 없음).
- **주장 2(인증 독립) 성립**: 삭제된 keyring/필드를 참조하는 auth/identity/composition 경로 0건.
  `assertDeliveryPolicy`는 delivery 관심사만 가드했음. 프로덕션 email delivery는 이미 미배선(기존 사실, T3 회귀 아님).

## Residual risks

- **삭제는 git 복원 가능**: 두 모듈 모두 프로덕션 소비자 0건이라 되살릴 필요는 T8+ 소비자가 요구할 때뿐.
- **actual-refs.ts는 verbatim 이전이라 넓다**: 각 함수가 읽지 않는 필드(PositionRow의 live-account 필드)도 포함 —
  f7 테스트 constructor의 excess-property 검사를 깨지 않으려는 의도(ponytail 주석 명시). 드리프트 시 좁힐 것.
- **provider-connections는 core/만 남음**: read-transport만 T4에서 제거, 모듈 전체 삭제는 Stage 3(메모 §6).
- **삭제 모듈이 shared 포트 카탈로그에 여전히 광고됨 (codex Medium, Stage 3 이월)**:
  `src/shared/contracts/module-interfaces.ts`가 삭제된 `NotificationCenter` 포트와 stateful
  `ActualPortfolio.open/change`(이제 순수 계산만 생존)를 여전히 export하고, `tests/public-seam.example.ts`가
  둘을 요구, 게스트 스냅샷(`terminal-view/presentation/guest/*`)이 alerts를 login-unlock으로 광고한다.
  **왜 지금 안 고치나**: ① 전부 **타입-only 선언**이라 런타임 파손 0(빌드·seam 통과) ② Stage 1에 삭제된
  `ResearchAssistant` 포트가 **이미 동일하게 dangling** — 저장소의 확립된 패턴 ③ 메모 §6이 **map/spec/contract
  카탈로그 전면 재작성을 Stage 3 직후로 명시 위임** ④ 소비처(identity-assembly는 주석 참조뿐, terminal-view
  게스트)가 **Stage 3 삭제 대상**이라 지금 편집하면 곧 지울 코드를 건드림. Stage 3 재작성 시 함께 제거.
  게스트 alert 광고도 notification-center가 이미 도달 UI 0이라 T3가 만든 위험이 아니다.
