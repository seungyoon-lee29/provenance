import type { ActualAccountReference, ActualJournalEntry, ActualJournalEntryReference, ActualRecordPayload } from "./contracts";

/**
 * Resolve the append-only journal into its effective records. Source rows are
 * never mutated, so effectiveness is derived: a superseding entry voids its
 * target and contributes its replacement; a reversal voids its target; and
 * because the journal keeps correction chains linear (a target is corrected at
 * most once, reversals are never targets), voiding a correction restores what
 * it corrected.
 */

export type EffectiveRecord = Readonly<{
  /** The journal entry that carries the effective payload. */
  entryReference: ActualJournalEntryReference;
  account: ActualAccountReference;
  recordedAt: string;
  /** UF-06: an opening position renders as a synthetic aggregate lot. */
  aggregateLot: boolean;
  payload: ActualRecordPayload;
}>;

export function effectiveRecords(entries: readonly ActualJournalEntry[]): readonly EffectiveRecord[] {
  const correctionOf = new Map<string, ActualJournalEntry>();
  for (const entry of entries) {
    if (entry.kind === "superseding") correctionOf.set(String(entry.supersedes), entry);
    if (entry.kind === "reversal") correctionOf.set(String(entry.reverses), entry);
  }

  const memo = new Map<string, boolean>();
  const effective = (entry: ActualJournalEntry): boolean => {
    const key = String(entry.entryReference);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const correction = correctionOf.get(key);
    const result = correction === undefined ? true : !effective(correction);
    memo.set(key, result);
    return result;
  };

  const records: EffectiveRecord[] = [];
  for (const entry of entries) {
    if (!effective(entry)) continue;
    if (entry.kind === "opening_position") {
      records.push(record(entry, { kind: "opening_position", position: entry.position }));
    } else if (entry.kind === "manual_position") {
      records.push(record(entry, { kind: "manual_position", position: entry.position }));
    } else if (entry.kind === "portfolio_activity") {
      records.push(record(entry, { kind: "portfolio_activity", activity: entry.activity }));
    } else if (entry.kind === "superseding") {
      records.push(record(entry, entry.replacement));
    }
    // reversals void; they never carry a row
  }
  return records;
}

function record(entry: ActualJournalEntry, payload: ActualRecordPayload): EffectiveRecord {
  return {
    entryReference: entry.entryReference,
    account: entry.account,
    recordedAt: entry.recordedAt,
    aggregateLot: payload.kind === "opening_position",
    payload,
  };
}
