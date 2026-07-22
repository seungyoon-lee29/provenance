import type { Erasable } from "../../../platform/persistence/fenced-store";

import type { ActualJournal } from "./journal";

/**
 * F6 ActualPortfolio erasure participant (SEC-09, spec §8: administrative
 * erasure is the ONLY removal path). One coordinator fence shreds the journal
 * (entries, receipts, revision counters, account ownership) plus every
 * registered derived store (personalized caches, exports and outboxes register
 * here as they materialize in F7/F10 — none exist in the baseline). The receipt
 * is the module's public erasure state: it carries the coordinator's fence and
 * real per-store shred counts, and a replayed sweep keeps the ORIGINAL receipt.
 */

export type ActualErasureReceipt = Readonly<{
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

export class ActualPortfolioErasure {
  readonly #receipts = new Map<string, ActualErasureReceipt>();

  constructor(
    private readonly deps: Readonly<{
      journal: ActualJournal;
      stores: readonly Readonly<{ label: string; store: Erasable }>[];
    }>,
  ) {}

  erase(context: ErasureContext): Promise<void> {
    const workspace = context.workspaceReference;
    const prior = this.#receipts.get(workspace);
    if (prior !== undefined && prior.fence >= context.fence) return Promise.resolve();

    const lines = [
      { label: "actual-journal", shredded: this.deps.journal.eraseWorkspace(workspace, context.fence) },
      ...this.deps.stores.map(({ label, store }) => ({ label, shredded: store.eraseSubject(workspace, context.fence) })),
    ];
    this.#receipts.set(workspace, { workspace, fence: context.fence, lines });
    return Promise.resolve();
  }

  receiptFor(workspace: string): ActualErasureReceipt | undefined {
    return this.#receipts.get(workspace);
  }
}
