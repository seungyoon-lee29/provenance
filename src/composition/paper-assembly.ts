import type { Pool } from "pg";

import { PgPaperJournalStore } from "../modules/paper-trading/internal/journal-store.pg";
import { PaperTradingService } from "../modules/paper-trading/internal/service";
import { SIMULATION_V1 } from "../modules/paper-trading/internal/simulator";
import type { PaperMoney } from "../modules/paper-trading/internal/contracts";

/**
 * T8 S2 — durable paper-trading assembly: the first PRODUCTION consumer of
 * `PgPaperJournalStore` (Stage 2 검증기록 ① discharged: the durable ledger is
 * now composed, not just contract-tested). Consumed by the CLI `paper`
 * commands; the backtest runner deliberately does NOT use this — a backtest
 * is an ephemeral deterministic computation on the in-memory store.
 *
 * The CLI is a single-owner local surface: its workspace lives in the
 * `cli:` namespace, disjoint from web identity workspaces, so web-side
 * erasure coordination never needs to reach these rows (PaperTradingErasure
 * assembly stays with the surface that owns account lifecycle — T11).
 */

export const CLI_WORKSPACE = "cli:local";

export function createDurablePaperTrading(
  deps: Readonly<{
    pool: Pool;
    seedCash: readonly PaperMoney[];
    now?: () => string;
  }>,
): PaperTradingService {
  let updateCounter = 0;
  return new PaperTradingService({
    now: deps.now ?? (() => new Date().toISOString()),
    // Single-owner local CLI: the epoch is constant — revocation semantics
    // belong to the web identity surface, which this assembly does not serve.
    identity: { currentAuthorizationEpoch: () => "cli" },
    // S2 scope is account provisioning/reading only. Market-order submission
    // needs a live observation source — that injection arrives with T11.
    observations: { currentObservation: () => undefined },
    policy: {
      policyVersion: SIMULATION_V1.policyVersion,
      seedCash: deps.seedCash,
      intentTtlMs: 60_000,
      maxSlippageBps: SIMULATION_V1.maxSlippageBps,
    },
    updateId: () => `cli:update:${(updateCounter += 1)}`,
    journalStore: new PgPaperJournalStore(deps.pool),
  });
}
