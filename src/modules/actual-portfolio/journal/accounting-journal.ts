import { FencedKeyedStore, type Erasable } from "../../../platform/persistence/fenced-store";
import { brandReference } from "../../../shared/contracts/brands";

import type { ActualAccountReference } from "../baseline/contracts";
import type {
  AccountingAppendOutcome,
  AccountingEntry,
  AccountingEvent,
  AccountingEventReference,
} from "./contracts";

type Receipt = Readonly<{ payload: string; outcome: AccountingAppendOutcome }>;

type CorrectionBody =
  | Readonly<{ kind: "superseding"; supersedes: AccountingEventReference; replacement: AccountingEvent }>
  | Readonly<{ kind: "reversal"; reverses: AccountingEventReference; reason: string }>;

type EntryBody = Readonly<{ kind: "event"; event: AccountingEvent }> | CorrectionBody;

/**
 * Append-only F7 accounting journal (spec §8 / AT-06): exactly-once via the
 * §8 receipt trio (same key + canonical payload → the ORIGINAL receipt; same
 * key + different payload → side-effect-free conflict), corrections append
 * superseding/reversal entries with linear chains, and everything — entries,
 * receipts, sequences — lives on `FencedKeyedStore` so SEC-09 erasure is one
 * fence: shredded state cannot be re-created by a late append.
 */
export class AccountingJournal implements Erasable {
  readonly #entries = new FencedKeyedStore<AccountingEntry>();
  readonly #receipts = new FencedKeyedStore<Receipt>();
  readonly #sequences = new FencedKeyedStore<number>();
  readonly #now: () => string;
  readonly #writeEpoch: () => number;

  constructor(now: () => string, writeEpoch: () => number = () => 1) {
    this.#now = now;
    this.#writeEpoch = writeEpoch;
  }

  append(workspace: string, event: AccountingEvent, options: Readonly<{ idempotencyKey: string }>): AccountingAppendOutcome {
    return this.#commit(workspace, event.account, `append|${event.kind}|${options.idempotencyKey}`, JSON.stringify(event), () => ({
      kind: "event",
      event,
    }));
  }

  supersede(
    workspace: string,
    target: AccountingEventReference,
    replacement: AccountingEvent,
    options: Readonly<{ idempotencyKey: string }>,
  ): AccountingAppendOutcome {
    return this.#correct(workspace, target, `supersede|${options.idempotencyKey}`, JSON.stringify({ target, replacement }), () => ({
      kind: "superseding",
      supersedes: target,
      replacement,
    }));
  }

  reverse(
    workspace: string,
    target: AccountingEventReference,
    reason: string,
    options: Readonly<{ idempotencyKey: string }>,
  ): AccountingAppendOutcome {
    return this.#correct(workspace, target, `reverse|${options.idempotencyKey}`, JSON.stringify({ target, reason }), () => ({
      kind: "reversal",
      reverses: target,
      reason,
    }));
  }

  #correct(
    workspace: string,
    target: AccountingEventReference,
    receiptKey: string,
    payload: string,
    body: () => CorrectionBody,
  ): AccountingAppendOutcome {
    const targetEntry = this.#entries.get(workspace, String(target));
    if (targetEntry === undefined) return { status: "refused", reason: "unknown_event" };
    // Replay check must use the same account-scoped receipt key #commit writes,
    // or a replayed correction reads its own prior append as "already corrected".
    const replay = this.#replay(workspace, `${targetEntry.account}|${receiptKey}`, payload);
    if (replay !== undefined) return replay;
    const draft = body();
    if (draft.kind === "superseding" && draft.replacement.account !== targetEntry.account) {
      return { status: "refused", reason: "unknown_event" };
    }
    // Superseding may only target a BASE event. Superseding a correction makes
    // the chain-parity rule resurrect the original alongside the new
    // replacement (adversarial panel 2026-07-18: A→sup B→sup C reported both A
    // and C — financial double count). Reversal of a correction stays allowed:
    // parity restores exactly one contributor in every reversal chain.
    if (draft.kind === "superseding" && targetEntry.kind !== "event") {
      return { status: "refused", reason: "already_corrected" };
    }
    if (this.#correctionOf(workspace).has(String(target))) return { status: "refused", reason: "already_corrected" };
    return this.#commit(workspace, targetEntry.account, receiptKey, payload, () => draft);
  }

  #replay(workspace: string, receiptKey: string, payload: string): AccountingAppendOutcome | undefined {
    const existing = this.#receipts.get(workspace, receiptKey);
    if (existing === undefined) return undefined;
    return existing.payload === payload ? existing.outcome : { status: "conflict" };
  }

  #commit(
    workspace: string,
    account: ActualAccountReference,
    receiptKey: string,
    payload: string,
    body: () => EntryBody,
  ): AccountingAppendOutcome {
    const scopedReceiptKey = `${account}|${receiptKey}`;
    const replay = this.#replay(workspace, scopedReceiptKey, payload);
    if (replay !== undefined) return replay;

    const epoch = this.#writeEpoch();
    const sequence = (this.#sequences.get(workspace, String(account)) ?? 0) + 1;
    const eventReference = brandReference<string, "AccountingEventReference">(
      `accounting:${workspace}:${account}:${sequence}`,
    ) as AccountingEventReference;
    const entry = { eventReference, account, sequence, recordedAt: this.#now(), ...body() } as AccountingEntry;
    if (!this.#entries.write(workspace, String(eventReference), entry, epoch)) return { status: "suppressed" };
    this.#sequences.write(workspace, String(account), sequence, epoch);
    const outcome: AccountingAppendOutcome = { status: "applied", sequence, eventReference };
    this.#receipts.write(workspace, scopedReceiptKey, { payload, outcome }, epoch);
    return outcome;
  }

  #correctionOf(workspace: string): Map<string, AccountingEntry> {
    const corrections = new Map<string, AccountingEntry>();
    for (const entry of this.#entries.list(workspace)) {
      if (entry.kind === "superseding") corrections.set(String(entry.supersedes), entry);
      else if (entry.kind === "reversal") corrections.set(String(entry.reverses), entry);
    }
    return corrections;
  }

  entries(workspace: string, account: ActualAccountReference): readonly AccountingEntry[] {
    return this.#entries
      .list(workspace)
      .filter((entry) => entry.account === account)
      .sort((left, right) => left.sequence - right.sequence);
  }

  /** Corrections resolved with chain parity: an entry counts iff its correction does not. */
  effectiveEvents(workspace: string, account: ActualAccountReference): readonly AccountingEvent[] {
    const corrections = this.#correctionOf(workspace);
    const memo = new Map<string, boolean>();
    const effective = (entry: AccountingEntry): boolean => {
      const key = String(entry.eventReference);
      const known = memo.get(key);
      if (known !== undefined) return known;
      const correction = corrections.get(key);
      const value = correction === undefined ? true : !effective(correction);
      memo.set(key, value);
      return value;
    };

    const events: AccountingEvent[] = [];
    for (const entry of this.entries(workspace, account)) {
      if (!effective(entry)) continue;
      if (entry.kind === "event") events.push(entry.event);
      else if (entry.kind === "superseding") events.push(entry.replacement);
    }
    return events;
  }

  eraseSubject(subject: string, fence: number): number {
    return (
      this.#entries.eraseSubject(subject, fence)
      + this.#receipts.eraseSubject(subject, fence)
      + this.#sequences.eraseSubject(subject, fence)
    );
  }
}
