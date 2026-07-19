import fc from "fast-check";

/**
 * Deterministic property runs. A fixed seed keeps the generated inputs stable
 * so the fast-check properties give a REPRODUCIBLE mutation score under Stryker
 * (a random seed would make the mutation gate flaky). numRuns stays at the
 * default breadth.
 */
fc.configureGlobal({ seed: 0x5eed, numRuns: 100 });
