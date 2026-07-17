# F6 (ticket 15) 진행 — Actual Portfolio baseline

Owner: main-agent. Claimed 2026-07-17T15:37:43+09:00. 기준 규칙: `docs/agents/collaboration.md`, spec §6·§8·UF-06·SEC-01/06/09·AT-06(baseline)/AT-07(isolation)·ADR A04.

## Blast-radius 프레이밍
- **되돌릴 수 없는 위험**: (1) Actual↔Paper 오염(실자산·모의자산 합산/원장 공유 — A04의 존재 이유), (2) 추정 금지 위반 — 과거 수익·tax lot 복원, known subtotal의 total 승격(잘못된 재무 표시), (3) erasure 미완주(삭제 뒤 계좌/journal 재생성). 외부 egress 없음(scripted price/FX port만, provider gate 부재) → F5보다 blast radius 작음.
- **Prevent**: Actual 전용 branded account/journal/repository 타입(Paper와 범용 mode interface 비공유 — 컴파일 타임 차단), command는 판별합집합, incomplete 상태에서 total이 표현 불가능한 view 타입(known subtotal + missing list만).
- **Contain**: append-only journal(source event 미덮어쓰기, superseding/reversal 추가만) + contiguous revision + idempotency receipt. F5 `FencedKeyedStore` 재사용으로 SEC-09 fence 구조화(bolt-on 금지 교훈 유지).
- **Detect**: 사람 검토 가능한 literal fixture(고정 clock), **blind test-authorship**(AT-06 baseline·AT-07 isolation acceptance는 spec+계약만으로 별도 에이전트).

## 추론 강도
- journal append-only/contiguous revision/idempotency·erasure = **XHigh**(재무 기록 무결성). completeness/승격 금지·PortfolioLoad stale-paint = **High**. presentation/fixture = Medium.

## Tier
- 돈 *기록* 경로(체결 아님)·외부 egress 없음 → 최상위 자동승격 대상은 durable journal(마이그레이션 경계)뿐. contain(in-memory fenced substrate, scripted port) 후 **High 방법(blind gate)** — F5와 동일 구조.

## 핵심 invariant
1. account별 journal은 append-only + contiguous revision. source event/activity 덮어쓰기 0, 수정은 superseding/reversal 추가로만. (§8)
2. `(workspace, module, account, command kind, idempotency key)`+canonical payload 동일 → 기존 receipt 재반환; 같은 key·다른 payload → side effect 0 conflict; stale expectedRevision → current revision 담은 rejected. (§8)
3. Opening Position = 기준일 synthetic aggregate lot 표시. 과거 거래·보유기간·tax lot·realized P&L 복원/표시 0. (UF-06)
4. incomplete price/FX/position에서 total·비중·Rebalancing Proposal 생성 0 — known subtotal + 누락 목록 + 원통화 값만. subtotal→total 승격 0. (UF-06/§8)
5. SEC-01: cross-workspace ID·stale auth epoch·workspace switch → side effect 0 거절. Viewer Context만 권한 근거.
6. A04: Actual과 Paper는 journal/account/cash/position/revision/projection 비공유(타입으로 강제). Paper 변화 ↔ Actual 공개 필드 상호 불변.
7. PortfolioLoad: initial은 마지막 정규화 상태만 대기, update는 section key·단조 sequence·revision vector·watermark·resume cursor 보유, stale result는 paint 0. (§8)
8. SEC-09: administrative erasure만 예외적 제거 경로 — account/journal/projection/source reference/개인화 cache/derived section fence 뒤 제거, late projection·backup restore 재생성 0, module receipt는 coordinator에 수집.

## 검증 oracle
- `npm run check`, browser/perf(§11: Actual initial projection p95 450/800ms), AT-06 baseline·AT-07 isolation 대조.
- **F6 한계 정직 기록**: AT-07의 행동적 상호 불변("Paper 변화 뒤 Actual 불변")은 PaperTrading(ticket 17)이 없어 baseline에서는 **구조적 격리(브랜드 타입 비호환 + 저장소 분리) + 타입 테스트(ts-expect-error)**로 증명하고, 행동 증명은 17에서 완성한다.

## 배치 (각 = 체크포인트, npm run check green 후 다음)
- [x] **B1 contracts + append-only journal spine** — `baseline/{contracts,journal}.ts`: Actual 전용 branded 타입(account/entry/instrument/source — Paper와 비호환), 5-command 판별합집합, `ActualJournal.append`가 invariant 1·2 구현 — contiguous revision(계정·workspace별 독립), superseding/reversal은 append만(원본 row 불변, unknown target refused·side effect 0), idempotency 3분기(동일 key+canonical payload→원 receipt 재반환·journal 무변화 / 같은 key 다른 payload→conflict / stale expectedRevision→current 담은 rejected), receipt scope에 command kind 포함(§8 5-tuple). SEC-09: fenced substrate 위 저장 + eraseWorkspace가 entries·revision counter·**receipts**까지 shred(receipt에 payload 사본 = 개인정보), 삭제 뒤 replay→suppressed·재생성 0. author 11 green(red-first), mutation 5/5 kill(conflict 제거·revision 비연속·supersede 덮어쓰기·stale 수용·receipt 잔존). check 793/60 green. commit b3b28f5. 진행 중 결정: Opening/Manual position 타입에 파생 필드(tax lot·realized·holding period) 자체가 부재 = 추정 금지의 Prevent 층.
- [x] **B2 projection + completeness** — `baseline/{projection,valuation}.ts`: `effectiveRecords`가 append-only 교정을 해소(supersede→replacement 유효·원본 journal 잔존, reverse→무효, **교정의 reverse→원본 복원** — journal이 `already_corrected`로 교정 체인을 선형 유지: 같은 target 이중 교정·reversal 재교정 거절), `presentPositionsSection`은 **승격 금지를 타입으로**: total·weight는 complete variant에만 존재, partial은 knownSubtotal+missing list(reason price/fx), FX 결측 시 원통화 값은 유지, rebalancing/proposal/파생 이력 필드 자체 부재(계산은 F7). scripted `ActualPriceFxPort`(실 배선은 `PortfolioEvidenceResolver` seam — shared/server/contracts.ts에 이미 존재 확인). author 11 green(red-first, B1 회귀 포함 22), mutation 5/5 kill(subtotal 승격·복원 규칙 파괴·FX 무시 rate1·aggregate-lot 탈락·이중 교정 허용). check 804/61 green. commit 5f598f8.
- [x] **B3 PortfolioLoad progressive open** — `baseline/portfolio-load.ts`: `ActualPortfolioService.open/change`(spec §6 시그니처). SEC-01: workspace는 Viewer Context에서만(command에 workspace 필드 자체 부재 = 위조 불가), **계좌 소유권은 journal에 최초 기록 시 고정** — cross-workspace 계좌 ID는 append 전 denied·side effect 0(TDD 중 발견: 소유권을 서비스 인스턴스에 두면 같은 journal의 두 서비스가 어긋남 → journal로 이전, eraseWorkspace가 ownership도 shred), guest/stale epoch denied(`ActualCommandOutcome`에 denied 추가 — 훅 typecheck가 누락 잡음). open: initial은 정규화 journal 상태만 대기(price/FX port 무접촉 — mutation으로 증명), refresh는 **emit 직전 epoch 재검사**(revoke 후 paint 0) + §8 메타 전체(단조 per-section sequence·request revision·scope·account revision vector·evidence watermark·policy version·unique id·resume cursor), resume cursor는 재전송 없이 이어감. pure `shouldPaint`가 out-of-order/중복/superseded request drop. author 9 green(red-first), mutation 5/5 kill(emit 재검사 제거·stale 수용·cross-ws 제거·sequence 고정·initial의 port 접촉). check 813/62 green. commit ae329a9.
- [x] **B4 erasure participant + isolation + blind 게이트** — `baseline/actual-erasure.ts`: 한 fence로 journal(entries·command receipts·revision counter·계좌 소유권)+등록 store shred, **실제 IdentityService coordinator**(reauth→fence-first)에서 receipt fence=공개 fence 일치, 삭제 뒤 replay/old-epoch write suppressed·읽기 empty·타 workspace 무접촉·비워진 계좌명은 타 workspace 새 lineage로만, replay sweep은 원본 receipt 유지. A04: 브랜드 비호환 @ts-expect-error(tsc 강제)+actual-portfolio 소스의 paper/live-trading import 부재 스캔. author 5+2 green, mutation 3/3 kill(소유권 잔존·receipt 덮어쓰기·허위 fence). **blind 게이트**: 별도 Sonnet 37 tests(공개 경로 import 검증), 35 green+후보 버그 2 보고 → **판정: 둘 다 구현 무결**. ①"전 position FX 결측→partial" 주장: 내 계약 문구 자기모순이 원인 — 경계는 '보고통화 평가 행 ≥1이면 partial'(₩0 knownSubtotal 오표시 방지), 원통화 값은 unavailable 행에도 유지(spec 충족)·혼합 케이스 partial 단언 추가. ②"100 동시 append→revision 1~100" 주장: **실측 반박**(tsx로 직접 측정: 전 결과=원 receipt(applied rev 1)·row 1개) — 그들 단언이 replay된 원 receipt의 status "applied"를 신규로 집계(자기 주석과 모순), 보고서의 revision 1~100 서술은 실측 불일치. 단언 2곳 판정대로 수정, 37/37 green, **blind-단독 mutation 3/3 kill**(receipt 비활성·partial 승격·emit 재검사 제거). check 857/65 green. commit d1dd0af.
- [ ] **B5 presentation + perf + closeout** — 표면(f5-inbox 선례), initial projection 450/800ms 예산, browser spec, ticket 15 closeout.

## 진행 로그
- 2026-07-17: claim + 계획 수립.
