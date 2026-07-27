// @ts-check
/**
 * 테스트 스위트의 음성 대조군.
 *
 * 다른 게이트들은 `scripts/gates/negative-control.sh` 가 나쁜 입력으로 red 를 실증한다.
 * 테스트 스위트에 대해 정확히 그 역할을 하는 것이 mutation testing 이다 — 소스를 고의로
 * 망가뜨렸을 때 red 가 나는가. 여기서 살아남은 mutant 는 "그 줄이 틀려도 스위트는 초록"
 * 이라는 뜻이고, 그건 A 그룹(조용히 틀린 값)이 통과할 수 있는 자리 그 자체다.
 *
 * 2026-07-27 (arch-2 A+B) 이전 상태가 이 도구의 요약이었다: **실패 능력을 재는 도구 자신이
 * 배선 안 된 채 엉뚱한 데를 겨누고 있었다.** 설정 주석은 스스로를 regression gate 라 불렀지만
 * `.husky/`·`.github/` 어디서도 안 불렸고, 대상은 돈 경로가 아닌 정책 파일 2개뿐이었다.
 * → CI `nightly-mutation` 에 배선 + money/accounting 경로(tier-gate 가 guarded 로 잡는
 *   바로 그 경로)로 재조준.
 *
 * 실측 baseline 2026-07-27 (2026 mutants, 4분 25초):
 *   total 61.55% / covered 78.72% — killed 1241, timeout 6, survived 337, no-coverage 442
 *   contracts.ts          100.00  ← A3 천장 집행이 잘 고정돼 있다
 *   corporate-actions.ts   96.94
 *   journal.ts             74.62
 *   runtime-policy.ts      72.24
 *   transfers.ts           71.43
 *   network-policy.ts      63.39
 *   performance-report.ts  27.92  ← 약점. no-coverage mutant 379개(이 파일 전체의 80%)로,
 *                                   이 파일 대부분이 테스트에 아예 닿지 않는다.
 * 이 약점은 이 커밋에서 고치지 않는다 — 먼저 **보이게** 만드는 것이 이 변경의 목적이다.
 *
 * `ignoreStatic` 은 켜지 않는다. static mutant 454개가 실행 시간의 98%지만, 끄면 그만큼이
 * 조용히 집계에서 빠져 점수만 올라간다 — 이 저장소가 고치고 있는 "skip 을 pass 로 집계"와
 * 같은 병이다. 7분은 nightly 에서 감당 가능하다.
 *
 * Run: `npm run test:mutation`.
 */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  reporters: ["clear-text", "json"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/composition/runtime-policy.ts",
    "src/platform/provider-transport/network-policy.ts",
    "src/modules/paper-trading/internal/contracts.ts",
    "src/modules/paper-trading/internal/journal.ts",
    "src/modules/paper-trading/backtest/performance-report.ts",
    "src/modules/actual-portfolio/calculation/transfers.ts",
    "src/modules/actual-portfolio/calculation/corporate-actions.ts",
  ],
  tempDirName: "dist/stryker-tmp",
  jsonReporter: { fileName: "dist/stryker/mutation-report.json" },
  // Keep non-source and environment artifacts (e.g. a `.codegraph` socket) out
  // of the mutation sandbox copy.
  //
  // **선언된 제외 (2026-07-27)**: `tests/f8-paper-performance.test.ts` 는 벽시계 p95 예산
  // 단언이다(2,000 주문 × 40회). Stryker 는 9개 러너를 동시에 띄우고 perTest 커버리지로
  // 계측하므로 이 레인에서는 그 측정이 부하 의존이 되어 dry run 이 5초 테스트 타임아웃에
  // 걸린다(실측: 단독 실행 156~192ms, Stryker dry run 에서 timeout). 예산 단언 자체는
  // `npm run check`·CI PR-fast 에서 그대로 집행된다 — 여기서만 빠진다.
  // 대가를 숨기지 말 것: 이 파일이 죽이던 mutant 만큼 점수가 낮게 나온다. 그건 정직한 값이고,
  // 결정적이지 않은 게이트를 초록으로 유지하는 것보다 낫다.
  ignorePatterns: [
    ".codegraph", "dist", ".next", "test-results", "coverage", "playwright-report", "*.zip",
    "tests/f8-paper-performance.test.ts",
  ],
  // `break` 는 실측 baseline(61.55) 바로 아래에 둔 회귀 게이트다 — 돈 경로의 단언을
  // 약화시키는 편집이 들어오면 점수가 떨어져 red 가 된다.
  // 여유가 1.55pt(≈31 mutant)뿐이다. 좁혀서 민감하게 두는 쪽을 택했지만, nightly 가
  // 무관한 이유로 빨개지기 시작하면 그건 게이트 신뢰를 갉아먹으므로 그때 재조정할 것.
  // ponytail: Stryker 의 threshold 는 **전역 하나뿐**이다. 그래서 performance-report 를
  // 개선하면서 journal 의 단언을 약화시키는 변경은 총점이 유지돼 통과할 수 있다.
  // 파일별 하한이 필요해지면 dist/stryker/mutation-report.json 을 읽는 후처리로 승격할 것.
  thresholds: { high: 90, low: 80, break: 60 },
};
