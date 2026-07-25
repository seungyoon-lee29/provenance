import type { Pool } from "pg";

import { PgPaperJournalStore } from "../modules/paper-trading/internal/journal-store.pg";
import { PaperTradingService } from "../modules/paper-trading/internal/service";
import { SIMULATION_V1 } from "../modules/paper-trading/internal/simulator";
import type { PaperMoney } from "../modules/paper-trading/internal/contracts";
import { brandReference } from "../shared/contracts/brands";
import type { WorkspaceViewerContext } from "../shared/contracts/viewer-context";

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

/**
 * The single-owner local surface's authorization epoch.
 *
 * ONE definition, consumed by both sides of the check — the viewer below and
 * the identity port in the assembly. They used to be two string literals held
 * together by a comment; drifting them would have made every paper read refuse
 * as `unavailable`, which reads as a database outage rather than a wiring typo.
 */
const CLI_AUTHORIZATION_EPOCH = "cli";


/**
 * The one place this surface's viewer is built (arch-1).
 *
 * It lives next to `CLI_WORKSPACE` and the epoch it must match, so the surface's
 * identity has a single definition — previously the CLI kept this private and
 * the operation catalog addressed the same account with a raw workspace string
 * instead, which is how two surfaces came to hand-assemble the same read.
 */
export function cliViewer(): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "cli",
    workspaceReference: brandReference<string, "WorkspaceReference">(CLI_WORKSPACE),
    accountReference: brandReference<string, "AccountReference">("cli:account"),
    sessionReference: brandReference<string, "SessionReference">("cli:session"),
    sessionGeneration: brandReference<string, "SessionGeneration">("cli:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">(CLI_AUTHORIZATION_EPOCH),
    membershipRevision: brandReference<string, "MembershipRevision">("cli:1"),
  };
}

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
    //
    // It is ALSO scoped to this surface's one workspace. Without that, a service
    // built here authorizes any workspace string a viewer claims, and arch-1 put
    // a door on it that returns ledger contents — so a viewer arriving from
    // anywhere else would read whatever workspace it named. Narrowing the port
    // is what makes the T8 rejection of a shared synthetic-viewer helper moot
    // rather than merely argued around: the helper can only ever reach
    // `cli:local`.
    //
    // The refusal is `undefined`, not some other epoch string: encoding denial
    // as a value in the same channel as the grant makes it guessable, and a
    // viewer carrying that value would be authorized everywhere (round 2 built
    // exactly that viewer and provisioned a foreign account with it).
    identity: {
      currentAuthorizationEpoch: (viewer) =>
        viewer.kind === "workspace" && String(viewer.workspaceReference) === CLI_WORKSPACE
          ? CLI_AUTHORIZATION_EPOCH
          : undefined,
    },
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
