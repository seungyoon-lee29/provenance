import type { Erasable } from "../../../platform/persistence/fenced-store";

import type { PaperJournal } from "./journal";

/**
 * F8 PaperTrading erasure participant (SEC-09; spec §9). One coordinator
 * fence shreds the Paper journal — accounts, orders, fills, reservations and
 * command receipts are all folds over it — plus every registered store
 * (order intents, AI material references, caches, pending queues as they
 * materialize). The receipt is the module's public erasure state: it carries
 * the coordinator's fence and real per-store shred counts, and a replayed
 * sweep keeps the ORIGINAL receipt. Behind the fence nothing regenerates:
 * provisioning, fills, intents and restores are all suppressed writes.
 */

export type PaperErasureReceipt = Readonly<{
  workspace: string;
  fence: number;
  lines: readonly Readonly<{ label: string; shredded: number }>[];
}>;

type ErasureContext = Readonly<{
  accountReference: string;
  workspaceReference: string;
  scope: "workspace" | "account";
  fence: number;
}>;

export class PaperTradingErasure {
  readonly #receipts = new Map<string, PaperErasureReceipt>();

  constructor(
    private readonly deps: Readonly<{
      journal: PaperJournal;
      stores: readonly Readonly<{ label: string; store: Erasable }>[];
    }>,
  ) {}

  /**
   * `tx` is the identity erase transaction (ticket 23 slice 3b-vi): the durable
   * journal shred MUST run on it, or a later rollback of the outer transaction
   * would restore the live account while the money ledger stayed deleted
   * (codex T2-b finding).
   */
  async erase(context: ErasureContext, tx?: unknown): Promise<void> {
    const workspace = context.workspaceReference;
    const prior = this.#receipts.get(workspace);
    if (prior !== undefined && prior.fence >= context.fence) return;

    const lines = [
      { label: "paper-journal", shredded: await this.deps.journal.eraseWorkspace(workspace, context.fence, tx) },
      ...this.deps.stores.map(({ label, store }) => ({ label, shredded: store.eraseSubject(workspace, context.fence) })),
    ];
    this.#receipts.set(workspace, { workspace, fence: context.fence, lines });
  }

  receiptFor(workspace: string): PaperErasureReceipt | undefined {
    return this.#receipts.get(workspace);
  }
}
