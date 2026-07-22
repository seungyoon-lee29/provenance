-- Stage 2 T2-b: persist the Internal Paper money ledger. The journal is the ONLY
-- mutation boundary for Paper cash/positions/orders (spec §9), so durability is
-- exactly these five tables: append-only entries, §8 command receipts,
-- exactly-once system keys, genesis-fixed account ownership, and the SEC-09
-- deletion fence. One append = one transaction across entry + receipt/key.

CREATE TABLE paper_journal_entry (
  workspace       text   NOT NULL,
  entry_reference text   NOT NULL,
  account         text   NOT NULL,
  revision        bigint NOT NULL,
  -- Write epoch vs the SEC-09 fence: rows a stale backup resurrects hydrate
  -- at/below the merged fence and are suppressed (backup-drill scenario 2).
  at_epoch        bigint NOT NULL,
  entry           jsonb  NOT NULL,
  PRIMARY KEY (workspace, entry_reference),
  -- Revision CAS made loud: two writers folding the same revision cannot both land.
  UNIQUE (workspace, account, revision)
);

-- §8 idempotency trio: original receipt replayed byte-identical across restarts.
CREATE TABLE paper_command_receipt (
  workspace         text  NOT NULL,
  receipt_key       text  NOT NULL,
  canonical_payload text  NOT NULL,
  at_epoch          bigint NOT NULL,
  outcome           jsonb NOT NULL,
  PRIMARY KEY (workspace, receipt_key)
);

-- Exactly-once system events (fill identities, corporate actions, genesis).
CREATE TABLE paper_system_key (
  workspace  text NOT NULL,
  scoped_key text NOT NULL,
  at_epoch   bigint NOT NULL,
  PRIMARY KEY (workspace, scoped_key)
);

-- An Internal Paper account belongs to exactly one workspace, fixed at genesis.
CREATE TABLE paper_account_owner (
  account   text PRIMARY KEY,
  workspace text NOT NULL,
  at_epoch  bigint NOT NULL
);

-- SEC-09 monotonic deletion fence per workspace: writes at/below are suppressed,
-- and a backup restore must re-merge this forward-only (see scripts/backup-drill.ts).
CREATE TABLE paper_journal_fence (
  workspace text   PRIMARY KEY,
  fence     bigint NOT NULL
);
