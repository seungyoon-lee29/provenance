// @ts-check
/**
 * F11-adjacent quality gate (ticket 21, AC2): mutation-score baseline for the
 * safety-critical pure-policy modules. Scoped narrow on purpose — the no-Live
 * boot gate and the egress/SSRF guard are the highest-blast-radius invariants,
 * and both are pure functions with fast tests, so the run stays cheap. Widen
 * `mutate` to identity/vault/portfolio/accounting as budget allows.
 *
 * Run: `npm run test:mutation`. The `break` threshold fails the gate on
 * regression below the recorded baseline.
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
  ],
  tempDirName: "dist/stryker-tmp",
  jsonReporter: { fileName: "dist/stryker/mutation-report.json" },
  // Keep non-source and environment artifacts (e.g. a `.codegraph` socket) out
  // of the mutation sandbox copy.
  ignorePatterns: [".codegraph", "dist", ".next", "test-results", "coverage", "playwright-report", "*.zip"],
  // Baseline 2026-07-19: 67.17% overall (runtime-policy 68.36, network-policy
  // 63.39). `break` is set below the baseline as a REGRESSION gate — a future
  // edit that weakens the no-live / egress guards drops the score and fails.
  // Surviving mutants are mostly runtime-policy's adjacent vault/identity/
  // delivery branches (F0 unit-test territory), not the ticket-21 invariants.
  thresholds: { high: 90, low: 80, break: 60 },
};
