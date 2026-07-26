# Stage 3 선행 — shared 포트 카탈로그의 죽은 항목 제거

## Blast radius / 검증 tier (착수 전 선언, 2026-07-26)

- **변경 성격**: 타입-only 선언 삭제. 런타임 코드 0줄, 동작 변경 0.
- **Blast radius**: `src/shared/contracts/` 안의 export 표면. 최악 결과 = `npm run check` red.
  containment 이후 되돌릴 수 없음 **없음**(git revert 한 번).
- **tier-gate**: `scripts/gates/tier-gate.sh` GUARDED 는 `paper-trading/`·`db/migrations/`·
  `platform/persistence/`·`platform/credential-vault/`·`actual-portfolio/calculation/`·
  `modules/identity/`. `src/shared/` 는 포함되지 않으므로 `Tier: top` 트레일러는 **기계적으로
  요구되지 않는다**. 그 사실 자체를 여기 적어 "조용히 지나쳤다" 와 구별한다.
- **선언 tier**: **낮음(기계적)**. 근거 — 되돌릴 수 없음 0 × blast radius 타입 표면.
  collaboration.md §"검증 깊이와 blast radius" 의 결정 원리(필요 decorrelation ∝ 되돌릴 수 없음 ×
  blast radius)를 그대로 적용한 결과다.
- **검증**: `npm run check`(typecheck·lint·test) 전량 + 판별력 실증 1종.
- **적대 리뷰**: 착수 **전**에 이미 수행됨 — 조사 3 + 적대 3 레인(아래 §3). 결정 자체가 그 산출물이다.

## 1. 무엇을 지우는가

`src/shared/contracts/module-interfaces.ts` 는 `560e7d3`(F0) **커밋 한 번**이 전부인
spec §6 전사본이다. 그 뒤 모듈들이 삭제되는 동안 한 번도 갱신되지 않았다.

`extends` / `implements` / `Pick<>` / `Omit<>` / 타입 주석 어느 형태로도 소비되지 않는 것:

| 인터페이스 | 상태 | 비고 |
|---|---|---|
| `ResearchAssistant` | 죽음 | 모듈은 Stage 1 에서 삭제됨 |
| `NotificationCenter` | 죽음 | 모듈은 Stage 2 T3 에서 삭제됨 |
| `ActualPortfolio` | 죽음 | Stage 2 T4 에서 calculation/ 만 남기고 축소 |
| `Identity` | 죽음 + **이름 충돌** | `identity/contracts.ts:23~` 이 값 타입 10종을 다른 모양으로 재선언 |
| `PaperTrading` | 죽음 + **이름 충돌** | `internal/contracts.ts:169`·`service.ts:124` 가 2종을 무관한 모양으로 재선언 |

살아남는 것(진짜 소비자 있음): `FinancialInformation`(3곳 extends) · `ProviderConnections`(extends) ·
`TerminalView`(`Pick<>`).

동반 삭제: 위 5종이 **독점 소유**하던 값 타입 24종, `PortfolioLoad<T>`(소비자 0),
그리고 이 삭제가 고아로 만드는 `brands.ts` 의 `AiMaterialReference`.

## 2. 왜 재작성이 아닌가

대체재가 이미 정착해 있다 — `src/modules/*/contracts.ts` **7개**. `identity`·`paper-trading` 은
shared 별칭을 쓰지 않고 `ContractValue<"X">` 헬퍼만 받아 자기 파일에서 재선언한다.
"재작성" 은 곧 이 7개를 다시 만드는 일이다. 원본 정의는 `.scratch/financial-terminal/spec.md:153`
**§6** 에 더 풍부한 형태(§5.4 정책·§8·§10 포함)로 git-tracked 상태다.

Stage 3(웹·인증 제거) 후 남는 실소비자는 `FinancialInformation` 하나다. 그때 이 파일은
`ContractValue` + `FinancialInformation` 만 남으며, **파일을 지우고** `FinancialInformation` 을
`src/modules/financial-information/` 로 접는 것이 자연스럽다. 그것도 재작성이 아니라 삭제다.

## 3. 이 결정이 뒤집은 기록 (반박 사유)

두 곳이 이 삭제를 **Stage 3 로 이월**해 두었다. 뒤집는 근거를 여기 남긴다.

1. `progress/t10-strategy-cli-mcp.md` 보류(기록) ① — "삭제하면 계약 타입까지 파급되고
   Stage 3 가 이 층을 재작성 대상으로 명시" → **두 절 다 틀렸다.**
   - 파급: **0**. 실증했다(§4).
   - 재작성 위임: 피벗 메모 `:311`·`:378` 이 위임한 것은 `map.md`/`spec.md` 재작성이다.
     메모가 밝힌 이유는 "지울 코드의 스펙을 미리 고쳐 쓰는 낭비 방지" 인데, 여기 5종의
     모듈은 **이미 지워졌다**(Stage 1·2). 그 이유가 이 항목들에 닿지 않는다.
2. `progress/stage2-cleanup.md` Residual risks — 이월 사유 4가지 중 ③("메모가 contract 카탈로그
   재작성을 Stage 3 로 위임")은 위와 같은 이유로 성립하지 않고, ④("소비처가 Stage 3 삭제 대상")는
   `module-interfaces.ts` 자신을 덮지 않는다. ①(런타임 파손 0)·②(ResearchAssistant 선례)는 참이나
   **지연의 근거이지 지연의 이유가 아니다** — 셋째 문서가 같은 항목을 또 이월한 시점에서
   비용이 역전됐다.

## 4. 검증 기록

`npm run check` 3단계 전량(본 저장소, 편집 후):

- `typecheck` → exit 0
- `lint` → 0 errors (`stryker.config.mjs` 경고 1건은 기존·무관)
- `test` → 772 passed / 60 skipped

**판별력 실증**: `tests/public-seam.example.ts` 만 삭제 전으로 되돌리면 `TS2305` ×3(+2), exit 2.
즉 픽스처 동반 수정은 선택이 아니라 필수이며, tsc 가 이 이름들을 실제로 보고 있음을 뜻한다.
(픽스처 헤더 주석은 실패 코드를 `TS2724` 로 적었는데 실측은 `TS2305` 다 — 이름 삭제는 2305,
2724 는 오타 후보를 제시하는 rename 변종. 주석을 실측에 맞춰 정정했다.)

측정: `module-interfaces.ts` 98 → 36줄.

## 5. 이 슬라이스가 닫지 **않는** 것

- **stage2 의 codex Medium 은 열린 채로 둔다.** 그 지적의 사용자 노출 절반이 살아 있다 —
  `guest-terminal-view.ts:161-164` 가 삭제된 모듈에 대해 `login_required` 패널(`ai`·`alerts`)을
  지금도 렌더한다. 타입 표면만 닫고 "정리됨" 으로 적으면 그게 이 저장소가 반복해 온
  "낡은 완료 주장" 이다.
- **`brands.ts` 의 나머지 고아 6종**(`ActualPortfolioReference`·`DeliveryTargetReference`·
  `DeliveryEndpointReference`·`FinancialDeliveryReference`·`SecurityEventReference`·
  `JobContextReference`, 전부 참조 0 실측)은 건드리지 않는다. 이번 삭제가 만든 고아가 아니라
  선행 삭제들이 남긴 것이고, 같은 커밋에 섞으면 이 슬라이스의 판별 범위가 흐려진다.
  → **후속 항목으로 등록**.
- **grep 사각지대 (별건, 중요)**: `src/modules/provider-connections/core/provider-connections-core.ts`
  는 `file(1)` 이 `data` 로 판정한다 — 오프셋 8220 에 map key 구분자용 NUL 바이트가 있어서다.
  `grep -n "ProviderConnections\b" <file>` → exit 1, `grep -an` → 2줄. **이 파일은 기본 grep/rg 에
  보이지 않는다.** 이번 조사도 1차에서 `ProviderConnections` 를 죽은 것으로 셀 뻔했고,
  `-a` 를 쓴 레인만이 `provider-connections-core.ts:46 extends ProviderConnections` 를 찾았다.
  저장소의 모든 "이거 죽었나?" 감사가 이 한 파일에 대해 조용히 틀린다. → **후속 항목으로 등록**.
