-- E-02 control plane schema
CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS issues (
  id uuid PRIMARY KEY,
  issue_key text NOT NULL UNIQUE,
  brand_slug text NOT NULL,
  audience_tz text NOT NULL,
  iso_week text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  status text NOT NULL,
  subject text,
  preheader text,
  html_sha256 text,
  text_sha256 text,
  freeze_json jsonb,
  ghl_campaign_id text,
  ghl_source_id text,
  ghl_trace_id text,
  archive_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS issues_status_idx ON issues (status);

CREATE TABLE IF NOT EXISTS content_items (
  id text PRIMARY KEY,
  schema_version text NOT NULL,
  kind text NOT NULL,
  source_id text NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  excerpt text NOT NULL,
  published_at timestamptz NOT NULL,
  cve_ids text[] NOT NULL DEFAULT '{}',
  raw_hash text NOT NULL,
  score double precision,
  extra jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_items_kind_published_idx ON content_items (kind, published_at DESC);

CREATE TABLE IF NOT EXISTS issue_items (
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  content_item_id text NOT NULL REFERENCES content_items(id),
  role text NOT NULL,
  sort_order integer NOT NULL,
  PRIMARY KEY (issue_id, content_item_id)
);

CREATE TABLE IF NOT EXISTS approval_tokens (
  id uuid PRIMARY KEY,
  token_sha256 text NOT NULL UNIQUE,
  issue_key text NOT NULL,
  revision integer NOT NULL,
  approver_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approval_tokens_issue_idx ON approval_tokens (issue_key, revision);

CREATE TABLE IF NOT EXISTS issue_events (
  id bigserial PRIMARY KEY,
  issue_key text NOT NULL,
  revision integer,
  event_type text NOT NULL,
  actor text,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS issue_events_issue_idx ON issue_events (issue_key, created_at);

CREATE OR REPLACE FUNCTION issue_events_forbid_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'issue_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS issue_events_no_update ON issue_events;
CREATE TRIGGER issue_events_no_update
  BEFORE UPDATE OR DELETE ON issue_events
  FOR EACH ROW EXECUTE FUNCTION issue_events_forbid_mutation();

CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  issue_key text NOT NULL,
  revision integer NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS kill_state (
  key text PRIMARY KEY,
  enabled boolean NOT NULL,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO kill_state (key, enabled, reason)
VALUES ('L1', false, 'default'), ('L2', false, 'default')
ON CONFLICT (key) DO NOTHING;
