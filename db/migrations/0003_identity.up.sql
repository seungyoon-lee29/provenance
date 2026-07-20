-- ticket 23 slice 3b-iii: persist the Identity spine — accounts, owned workspaces, sessions, and the
-- monotonic SEC-09 deletion fence. Session expiry is judged on the app-injected clock (bigint ms
-- columns), never SQL now(), so behaviour is deterministic and identical to the in-memory oracle.

-- Monotonic global source for the deletion fence, mirroring the in-memory #globalFence counter.
CREATE SEQUENCE identity_fence_seq;

CREATE TABLE identity_account (
  account_reference   text PRIMARY KEY,
  authorization_epoch bigint NOT NULL,
  membership_revision bigint NOT NULL,
  security_revision   bigint NOT NULL,
  state               text NOT NULL,
  email_key           text,
  identity_key        text,
  email_verified      boolean NOT NULL
);
-- Email / federated identity lookups. Partial-unique so multiple accounts may have a NULL key.
CREATE UNIQUE INDEX identity_account_email_key ON identity_account (email_key) WHERE email_key IS NOT NULL;
CREATE UNIQUE INDEX identity_account_identity_key ON identity_account (identity_key) WHERE identity_key IS NOT NULL;

CREATE TABLE identity_account_workspace (
  account_reference   text NOT NULL REFERENCES identity_account (account_reference),
  workspace_reference text NOT NULL,
  PRIMARY KEY (account_reference, workspace_reference)
);

CREATE TABLE identity_session (
  session_hash        text PRIMARY KEY,
  session_reference   text NOT NULL,
  account_reference   text NOT NULL REFERENCES identity_account (account_reference),
  workspace_reference text NOT NULL,
  generation          bigint NOT NULL,
  epoch_at_issue      bigint NOT NULL,
  created_at_ms       bigint NOT NULL,
  last_seen_at_ms     bigint NOT NULL,
  absolute_expiry_ms  bigint NOT NULL,
  revoked             boolean NOT NULL
);
CREATE INDEX identity_session_account ON identity_session (account_reference);

-- Presence of a row = the account is erased (tombstone); `fence` is the monotonic high-water mark.
CREATE TABLE identity_account_fence (
  account_reference text PRIMARY KEY REFERENCES identity_account (account_reference),
  fence             bigint NOT NULL
);
