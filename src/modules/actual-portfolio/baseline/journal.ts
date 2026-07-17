import { brandReference } from "../../../shared/contracts/brands";

import { FencedKeyedStore } from "../../notification-center/fenced-store";
import type {
  ActualAccountReference,
  ActualCommandOutcome,
  ActualJournalEntry,
  ActualJournalEntryReference,
  ActualPortfolioCommand,
} from "./contracts";

/**
 * F6 append-only Actual journal (spec §8). Source rows are never mutated —
 * corrections are appended as superseding/reversal entries — and each account
 * keeps a contiguous revision stream. Commands are idempotent on
 * `(workspace, module, account, command kind, idempotency key)` + canonical
 * payload: an exact replay returns the original receipt, a payload mismatch is
 * a side-effect-free conflict, and a stale expected revision is rejected with
 * the current revision. The rows sit on the fenced substrate, so
 * administrative erasure (the ONLY removal path) shreds them and suppresses
 * any late replay or restore at a pre-erasure epoch (SEC-09).
 */

type MutationControl = Readonly<{ idempotencyKey: string; expectedRevision: string }>;
type Receipt = Readonly<{ canonicalPayload: string; outcome: ActualCommandOutcome }>;

const MODULE = "actual";

export class ActualJournal {
  readonly #entries = new FencedKeyedStore<ActualJournalEntry>();
  readonly #revisions = new Map<string, number>();
  readonly #receipts = new Map<string, Receipt>();

  constructor(
    private readonly now: () => string,
    private readonly writeEpoch: () => number = () => 1,
  ) {}

  append(workspace: string, command: ActualPortfolioCommand, control: MutationControl): ActualCommandOutcome {
    const receiptKey = `${workspace}|${MODULE}|${String(command.account)}|${command.kind}|${control.idempotencyKey}`;
    const canonicalPayload = JSON.stringify(command);
    const prior = this.#receipts.get(receiptKey);
    if (prior !== undefined) {
      return prior.canonicalPayload === canonicalPayload ? prior.outcome : { status: "conflict" };
    }

    const accountKey = `${workspace}|${String(command.account)}`;
    const currentRevision = this.#revisions.get(accountKey) ?? 0;
    if (control.expectedRevision !== String(currentRevision)) {
      return { status: "rejected", currentRevision };
    }

    if (command.kind === "supersede_entry" || command.kind === "reverse_entry") {
      if (this.#entries.get(workspace, entryKey(command.account, command.target)) === undefined) {
        return { status: "refused", reason: "unknown_entry" };
      }
    }

    const revision = currentRevision + 1;
    const entryReference = brandReference<string, "ActualJournalEntryReference">(
      `actual-entry:${String(command.account)}:${revision}`,
    );
    const entry = buildEntry(command, entryReference, revision, this.now());
    // The fence is the ONLY thing that can stop an accepted command: behind it
    // nothing lands and nothing is receipted (no post-erasure regeneration).
    const written = this.#entries.write(workspace, entryKey(command.account, entryReference), entry, this.writeEpoch());
    if (!written) return { status: "suppressed" };
    this.#revisions.set(accountKey, revision);
    const outcome: ActualCommandOutcome = { status: "applied", revision, entryReference };
    this.#receipts.set(receiptKey, { canonicalPayload, outcome });
    return outcome;
  }

  list(workspace: string, account: ActualAccountReference): readonly ActualJournalEntry[] {
    return this.#entries
      .list(workspace)
      .filter((entry) => String(entry.account) === String(account))
      .sort((left, right) => left.revision - right.revision);
  }

  currentRevision(workspace: string, account: ActualAccountReference): number {
    return this.#revisions.get(`${workspace}|${String(account)}`) ?? 0;
  }

  /** SEC-09: shred entries, revision counters and command receipts behind the fence. */
  eraseWorkspace(workspace: string, fence: number): number {
    for (const key of [...this.#revisions.keys()]) if (key.startsWith(`${workspace}|`)) this.#revisions.delete(key);
    for (const key of [...this.#receipts.keys()]) if (key.startsWith(`${workspace}|`)) this.#receipts.delete(key);
    return this.#entries.eraseSubject(workspace, fence);
  }
}

function entryKey(account: ActualAccountReference, entry: ActualJournalEntryReference): string {
  return `${String(account)}|${String(entry)}`;
}

function buildEntry(
  command: ActualPortfolioCommand,
  entryReference: ActualJournalEntryReference,
  revision: number,
  recordedAt: string,
): ActualJournalEntry {
  const base = { entryReference, account: command.account, revision, recordedAt };
  switch (command.kind) {
    case "record_opening_position":
      return { ...base, kind: "opening_position", position: command.position };
    case "record_manual_position":
      return { ...base, kind: "manual_position", position: command.position };
    case "record_activity":
      return { ...base, kind: "portfolio_activity", activity: command.activity };
    case "supersede_entry":
      return { ...base, kind: "superseding", supersedes: command.target, replacement: command.replacement };
    case "reverse_entry":
      return { ...base, kind: "reversal", reverses: command.target, reason: command.reason };
  }
}
