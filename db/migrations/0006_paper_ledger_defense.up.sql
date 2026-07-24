-- Stage 2-c: a defense layer under the Paper money ledger. The current code path
-- cannot produce either divergence below, but an external write or a partial
-- restore could — and the fold reads money from the `entry` JSONB while the CAS
-- and idempotency records key off the relational columns. If the two disagree,
-- money moves against one story and is recorded against another. These constraints
-- make that unrepresentable at the database, not just unlikely in the code.

-- Defense 1 — the entry JSONB must agree with its indexed columns. The fold folds
-- `entry->>'account'`/`revision`; the UNIQUE (workspace, account, revision) CAS and
-- the (workspace, entry_reference) PK use the columns. A row where they diverge
-- would let a forged entry pass the CAS yet fold as a different account/amount.
-- The `entry ? 'key'` presence tests are load-bearing: PostgreSQL passes a CHECK
-- whose result is NULL, so a JSONB missing `account`/`revision`/`entryReference`
-- would satisfy `entry->>'account' = account` (NULL = text → NULL) and slip through,
-- then hydrate under `workspace|undefined`. Require the keys, THEN compare.
ALTER TABLE paper_journal_entry
  ADD CONSTRAINT paper_journal_entry_jsonb_matches_columns CHECK (
    entry ? 'entryReference' AND entry ? 'account' AND entry ? 'revision'
    AND entry->>'entryReference' = entry_reference
    AND entry->>'account' = account
    AND (entry->>'revision')::bigint = revision
  );

-- Defense 2 — a §8 receipt or exactly-once system key must point at a real entry.
-- The store writes the receipt/key FIRST (so a duplicate is caught before the
-- entry insert), then the entry, in ONE transaction; the FK is DEFERRABLE INITIALLY
-- DEFERRED so that ordering holds while still refusing, at COMMIT, any receipt/key
-- with no backing entry. Tables are empty at migration time (verify-migrations runs
-- on a fresh schema), so the new column is NOT NULL from the start.
ALTER TABLE paper_command_receipt ADD COLUMN entry_reference text NOT NULL;
ALTER TABLE paper_command_receipt
  ADD CONSTRAINT paper_command_receipt_entry_fk
  FOREIGN KEY (workspace, entry_reference)
  REFERENCES paper_journal_entry (workspace, entry_reference)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE paper_system_key ADD COLUMN entry_reference text NOT NULL;
ALTER TABLE paper_system_key
  ADD CONSTRAINT paper_system_key_entry_fk
  FOREIGN KEY (workspace, entry_reference)
  REFERENCES paper_journal_entry (workspace, entry_reference)
  DEFERRABLE INITIALLY DEFERRED;
