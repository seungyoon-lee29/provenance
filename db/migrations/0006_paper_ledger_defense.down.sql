-- Reverse Stage 2-c ledger defense layer.
ALTER TABLE paper_system_key DROP CONSTRAINT paper_system_key_entry_fk;
ALTER TABLE paper_system_key DROP COLUMN entry_reference;

ALTER TABLE paper_command_receipt DROP CONSTRAINT paper_command_receipt_entry_fk;
ALTER TABLE paper_command_receipt DROP COLUMN entry_reference;

ALTER TABLE paper_journal_entry DROP CONSTRAINT paper_journal_entry_jsonb_matches_columns;
