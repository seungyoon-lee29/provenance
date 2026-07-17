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
- [ ] **B1 contracts + append-only journal spine** — `src/modules/actual-portfolio/baseline/{contracts,journal}.ts`: branded Actual 타입, command 판별합집합(open_position/manual_position/portfolio_activity/supersede/reverse), contiguous revision, invariant 1·2(idempotency 3분기), fenced substrate 위 저장. author TDD + mutation.
- [ ] **B2 projection + completeness** — journal→position/section projection, Opening Position aggregate-lot 표시 필드, incomplete matrix(가격 결측→ known subtotal+missing list, total/비중 unavailable), 추정 금지(invariant 3·4). literal fixture.
- [ ] **B3 PortfolioLoad progressive open** — `ActualPortfolio.open` initial/updates: section watermark·sequence·resume cursor·emit 직전 재검사(stale paint 0, invariant 7), SEC-01 viewer 게이트(invariant 5).
- [ ] **B4 erasure participant + isolation + blind 게이트** — SEC-09 participant(F5 패턴: coordinator 실통합), A04 타입 격리 테스트, **blind acceptance**(별도 Sonnet: AT-06 baseline commands/idempotency/completeness + AT-07 구조 격리 + SEC-09).
- [ ] **B5 presentation + perf + closeout** — 표면(f5-inbox 선례), initial projection 450/800ms 예산, browser spec, ticket 15 closeout.

## 진행 로그
- 2026-07-17: claim + 계획 수립.
