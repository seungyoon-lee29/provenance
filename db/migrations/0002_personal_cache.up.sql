-- ticket 23: persist F4 PersonalCache (entries + monotonic SEC-09 deletion fence).
CREATE TABLE personal_cache_fence (
  workspace text PRIMARY KEY,
  fence bigint NOT NULL
);

CREATE TABLE personal_cache_entry (
  workspace text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (workspace, key)
);
