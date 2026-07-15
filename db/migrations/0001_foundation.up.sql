CREATE TABLE runtime_components (
  component_name text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO runtime_components (component_name) VALUES ('app'), ('worker');
