# 티켓 05 테스트·성능·무료 운영 검수 보고서

- **Target**: `.scratch/financial-terminal/issues/05-define-testing-seams.md`와 무료 공급자 결정 문서
- **Reviewers**: testing·correctness, performance·UX, free-only provider·license·security·reliability
- **Date**: 2026-07-14

## Severity summary

| Dimension | Critical | High | Medium | Low | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Testing·correctness | 0 | 4 | 6 | 0 | 10 |
| Performance·UX | 0 | 4 | 5 | 1 | 10 |
| Free provider·security·reliability | 0 | 2 | 4 | 0 | 6 |
| **Total** | **0** | **10** | **15** | **1** | **26** |

세 관점의 file·line 근거를 통합하고 같은 원인의 반복 지적은 한 finding으로 유지했다. 1차 수정 뒤 testing에서 reconnect 보존 경계 High 1건, performance에서 HTTP route mix Medium 1건이 새로 발견돼 위 집계에 포함했다. scripted provider exact delay는 기존 Broker Sync fixture finding의 잔여 조건으로 합쳤다. 26건을 모두 반영한 뒤 세 reviewer가 읽기 전용 spot re-review를 수행했으며 미해결 finding과 새 회귀가 없음을 확인했다.

## Testing·correctness findings

### High

1. **Paper Order property test가 production reducer를 oracle로 재사용할 수 있음** — event별 세 상태축·reservation·cash·position literal trace와 독립 invariant를 사용하고 production transition table import를 금지했다.
2. **Broker Paper crash·revoke race의 외부 observable이 불충분함** — 네 named fault point를 두고 공개 Paper view와 scripted broker lookup에서 외부 주문 최대 1개, blind retry 0과 reservation 일치를 검증한다.
3. **Broker Sync fault 목록에 독립 fixture와 기대 공개 결과가 없음** — literal page·event·snapshot trace와 `ActualPortfolio.open` 결과로 partial, cursor, ordering, checksum, projection gap과 fence를 판정한다.
4. **revoke/disconnect와 administrative delete 결과가 혼합됨** — retain은 frozen Disconnected Broker Account를 보존하고 administrative delete만 영구 제거하며 reconnect lineage 조건을 명시했다.

### Medium

1. **21개 chart 조합 중 두 조합만 상세 golden임** — 모든 조합에 range, interval, first/last, count와 대표 OHLCV literal manifest를 둔다.
2. **layout revision·idempotency·guest adoption 계약 누락** — same/different payload, stale revision, cross-user와 명시적 adoption을 `changeLayout → open/reload`로 검증한다.
3. **Performance Coverage 불완전성 worked example 누락** — flow 경계 valuation, Opening Position/Snapshot-only와 same-sign XIRR에서 value 없는 unavailable을 고정했다.
4. **Price Basis 중복 수익과 Corporate Action crash atomicity 누락** — raw/restated 결과 일치, total-return series 거절과 all-old/all-new 공개 view를 검증한다.
5. **CredentialVault crypto·rotation oracle이 추상적임** — NIST vector, tamper/AAD/nonce/rotation/rewrap와 sentinel log-sink 검사를 명시했다.
6. **Live route 부재 검증이 내부 registry에 결합될 수 있음** — exported HTTP/OpenAPI·generated client, black-box 404/405와 AuthorizedTransport 거절을 정본으로 삼는다.

## Performance·UX findings

### High

1. **stream update의 최종 browser paint 예산 없음** — commit revision과 Playwright mark를 연결한 desktop 750 ms/mobile 1,200 ms p95를 추가했다.
2. **update rate와 fan-out 의미가 불명확함** — source rate, payload, subscription, fan-out과 total browser delivery를 분리해 고정했다.
3. **명목 부하와 latency gate가 연결되지 않음** — 명목 부하는 모든 HTTP·browser·worker p95를 유지하고 stress는 각 명목 예산의 2배를 상한으로 삼는다.
4. **Broker Sync·deep rebuild 예산의 provider 분리와 fixture 부족** — request/page 20 ms scripted provider, 표준 sync와 최대 rebuild fixture 및 browser-visible 종점을 고정했다.

### Medium

1. **initial 뒤 background refresh 시작 예산 없음** — 허용된 모든 durable refresh enqueue를 250 ms p95로 제한했다.
2. **p50의 합격 용도가 불명확함** — p50은 추세 경고, p95와 Web Vitals p75만 release gate로 결정했다.
3. **CI flake 억제 규칙 부족** — runtime·browser pin, dedicated runner, warm-up, monotonic clock과 invalid-run 조건을 명시했다.
4. **field Web Vitals 표본 규칙 없음** — 최근 7일·device별 200 navigation을 요구하고 부족하면 lab gate를 사용한다.
5. **mixed HTTP route 구성과 표본 수 없음** — route 비율 합계 100%와 nominal/stress 최소 sample을 고정했다.

### Low

1. **interaction 수치의 percentile·동작이 암묵적임** — 모두 p95로 통일하고 drag·resize·split의 고정 5초·60 Hz 경로를 정의했다.

## Free provider·security·reliability findings

### High

1. **파생물 생성 권리가 없는 Evidence에 local fallback을 허용함** — derivative generation이 금지되면 Gemini와 local rule 호출을 모두 0으로 하고 value 없는 `license_restricted`를 반환한다.
2. **Alpaca와 KIS sandbox에 같은 lookup·idempotency를 가정함** — provider capability manifest, 분리된 read/order flag와 unsupported/submission_unknown 경계를 사용한다.

### Medium

1. **모든 403을 license_restricted로 정규화함** — entitlement, credential/account authorization과 기타 upstream forbidden을 typed contract로 분류한다.
2. **일반 PR의 outbound network 차단 누락** — credential을 주입하지 않고 localhost·선언된 Docker network 밖 egress를 거절한다.
3. **paid startup과 guest→personal/developer 차단 negative test 누락** — adapter 생성 전 startup reject와 route·schedule·request·cache·outbox 0을 검증한다.
4. **hard-expired Broker Snapshot의 current/frozen 경계가 모호함** — current outcome value를 제거하고 frozen evidence를 current total·P&L·rebalance·fill에서 제외한다.

## Residual implementation risks

- 실제 무료 공급자의 availability, quota와 latency는 release 성능 SLO가 아니라 별도 운영 evidence다.
- Gemini key 형식 변화, Open DART·KRX 승인 만료와 데이터 권리는 구현 시 entitlement contract로 다시 확인해야 한다.
- 실제 브라우저·저가 모바일 GPU, stream compression과 payload 변화는 lab fixture 밖이므로 운영 RUM과 정기 smoke가 필요하다.
- property seed·shrink trace, decimal/tick/lot rounding, broker sandbox 상태와 provider capability는 CI artifact로 보존해야 한다.
- 현재 결과는 설계·합격 기준의 검증이며 실행 코드와 실데이터 화면은 후속 구현 ticket에서 별도로 증명해야 한다.
