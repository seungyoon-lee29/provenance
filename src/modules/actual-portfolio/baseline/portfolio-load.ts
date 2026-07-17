import type { ViewerContext } from "../../../shared/contracts/viewer-context";

import type { ActualJournal } from "./journal";
import type { ActualCommandOutcome, ActualPortfolioCommand } from "./contracts";
import { effectiveRecords } from "./projection";
import type { EffectiveRecord } from "./projection";
import { presentPositionsSection } from "./valuation";
import type { ActualPriceFxPort, PositionsSection } from "./valuation";

/**
 * F6 `ActualPortfolio.open/change` (spec §6/§8, SEC-01).
 *
 * The workspace comes ONLY from the Viewer Context — commands carry no
 * workspace field, so a client-sent workspace id cannot be an authority. An
 * account belongs to the workspace that first recorded into it; any other
 * workspace touching it is denied with zero side effects. `open` returns an
 * initial shell that waits only for the normalized journal state (the price/FX
 * port is never consulted for it), and section refreshes re-check the account
 * authorization epoch immediately before emitting, so a revoked session paints
 * nothing. Every update carries the §8 metadata (section key, monotonic
 * per-section sequence, request revision, auth epoch, scope, account revision
 * vector, evidence watermark, policy version, unique id, resume cursor); the
 * caller-side `shouldPaint` drops stale or superseded updates.
 */

export type ActualSectionKey = "positions" | "valuation";

export type ActualPortfolioRequest = Readonly<{
  sections: readonly ActualSectionKey[];
  requestRevision: string;
  /** Resume cursors from a previous stream, e.g. `{ valuation: "valuation:2" }`. */
  resume?: Partial<Record<ActualSectionKey, string>>;
}>;

export type ActualInitialShell =
  | Readonly<{ status: "denied" }>
  | Readonly<{
      status: "ready";
      requestRevision: string;
      positions: readonly EffectiveRecord[];
      sections: Readonly<Record<ActualSectionKey, "ready" | "pending">>;
    }>;

export type ActualSectionUpdate = Readonly<{
  updateId: string;
  sectionKey: ActualSectionKey;
  sequence: number;
  requestRevision: string;
  authorizationEpoch: string;
  scope: string;
  accountRevisions: Readonly<Record<string, number>>;
  evidenceWatermark: string;
  policyVersion: string;
  resumeCursor: string;
  section: PositionsSection;
}>;

export type ActualPortfolioLoad = Readonly<{
  initial: Promise<ActualInitialShell>;
  /** Compute and emit one section update; undefined when auth fails the emit-time recheck. */
  refresh(section: ActualSectionKey): Promise<ActualSectionUpdate | undefined>;
}>;

export type ActualPortfolioDependencies = Readonly<{
  journal: ActualJournal;
  port: ActualPriceFxPort;
  identity: Readonly<{ currentAuthorizationEpoch(viewer: ViewerContext): string }>;
  policyVersion: string;
  now: () => string;
  updateId: () => string;
}>;

export function shouldPaint(
  lastPainted: Readonly<{ sequence: number }> | undefined,
  incoming: Readonly<{ sequence: number; requestRevision: string }>,
  currentRequestRevision: string,
): boolean {
  if (incoming.requestRevision !== currentRequestRevision) return false;
  if (lastPainted !== undefined && incoming.sequence <= lastPainted.sequence) return false;
  return true;
}

export class ActualPortfolioService {
  constructor(private readonly deps: ActualPortfolioDependencies) {}

  change(command: ActualPortfolioCommand, control: Readonly<{ idempotencyKey: string; expectedRevision: string }>, viewer: ViewerContext): ActualCommandOutcome {
    if (!this.#authorized(viewer)) return { status: "denied" };
    const workspace = String(viewer.workspaceReference);
    // Account ownership lives in the journal (fixed at first record), so a
    // cross-workspace account id is denied before anything is appended.
    const owner = this.deps.journal.ownerOf(command.account);
    if (owner !== undefined && owner !== workspace) return { status: "denied" };
    return this.deps.journal.append(workspace, command, control);
  }

  open(request: ActualPortfolioRequest, viewer: ViewerContext): ActualPortfolioLoad {
    if (!this.#authorized(viewer)) {
      return { initial: Promise.resolve({ status: "denied" }), refresh: () => Promise.resolve(undefined) };
    }
    const workspace = String(viewer.workspaceReference);
    const sequences = new Map<ActualSectionKey, number>();
    for (const [section, cursor] of Object.entries(request.resume ?? {})) {
      const resumed = Number.parseInt(cursor.split(":")[1] ?? "", 10);
      if (Number.isInteger(resumed) && resumed >= 0) sequences.set(section as ActualSectionKey, resumed);
    }

    const initial: ActualInitialShell = {
      status: "ready",
      requestRevision: request.requestRevision,
      // Initial waits only for the last normalized journal state; valuation
      // (the price/FX port) never blocks or feeds the shell.
      positions: this.#records(workspace),
      sections: {
        positions: "ready",
        valuation: request.sections.includes("valuation") ? "pending" : "ready",
      },
    };

    return {
      initial: Promise.resolve(initial),
      refresh: (section) => Promise.resolve(this.#refresh(section, request, viewer, workspace, sequences)),
    };
  }

  #refresh(
    section: ActualSectionKey,
    request: ActualPortfolioRequest,
    viewer: ViewerContext,
    workspace: string,
    sequences: Map<ActualSectionKey, number>,
  ): ActualSectionUpdate | undefined {
    // SEC-01: re-check immediately before emit — a revoke/switch after open
    // must not paint one more frame.
    if (!this.#authorized(viewer)) return undefined;
    const records = this.#records(workspace);
    const presented = presentPositionsSection(records, this.deps.port);
    const sequence = (sequences.get(section) ?? 0) + 1;
    sequences.set(section, sequence);
    const accountRevisions: Record<string, number> = {};
    for (const account of this.deps.journal.accounts(workspace)) {
      accountRevisions[String(account)] = this.deps.journal.currentRevision(workspace, account);
    }
    return {
      updateId: this.deps.updateId(),
      sectionKey: section,
      sequence,
      requestRevision: request.requestRevision,
      authorizationEpoch: viewer.kind === "workspace" ? String(viewer.accountAuthorizationEpoch) : "",
      scope: workspace,
      accountRevisions,
      evidenceWatermark: this.deps.now(),
      policyVersion: this.deps.policyVersion,
      resumeCursor: `${section}:${sequence}`,
      section: presented,
    };
  }

  #records(workspace: string): readonly EffectiveRecord[] {
    const records: EffectiveRecord[] = [];
    for (const account of this.deps.journal.accounts(workspace)) {
      records.push(...effectiveRecords(this.deps.journal.list(workspace, account)));
    }
    return records;
  }

  #authorized(viewer: ViewerContext): viewer is ViewerContext & { kind: "workspace" } {
    if (viewer.kind !== "workspace") return false;
    return this.deps.identity.currentAuthorizationEpoch(viewer) === String(viewer.accountAuthorizationEpoch);
  }
}
