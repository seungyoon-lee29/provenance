-- ticket 23 slice 3b-iii-b: durable revoke/erasure command receipts (idempotency + restart survival).
-- Keyed by (kind, proof_hash, idempotency_key): a destructive command shreds its own session, so a
-- retry carries a now-dead proof that can never be re-resolved to an account — the receipt must be
-- found pre-resolve by the proof hash it was issued under. payload_hash is a SEPARATE column (never in
-- the key) so a same-key/same-payload retry replays the stored outcome while a same-key/different-payload
-- retry is a side-effect-free conflict, not a double-execution (SEC design decision #3). No FK to
-- identity_account: the receipt is a pre-resolve artifact and must outlive the shredded session.
CREATE TABLE identity_receipt (
  kind            text  NOT NULL,
  proof_hash      text  NOT NULL,
  idempotency_key text  NOT NULL,
  payload_hash    text  NOT NULL,
  outcome         jsonb NOT NULL,
  PRIMARY KEY (kind, proof_hash, idempotency_key)
);
