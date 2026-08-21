-- Lifecycle through `sent`: reconciliation provenance and outbox retry state.

-- Which audience a send actually addressed, and whether it was a real send.
--
-- countProductionSent() feeds dual-control graduation: after the first N
-- production issues, the second approver is no longer required. Before these
-- columns it counted every row with status='sent' regardless of environment,
-- so once reconcile could set 'sent', a staging or DRY_RUN reconcile would
-- have graduated dual-control without a single real production send ever
-- happening. The count now requires a production slot and a non-dry-run send.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS audience_slot text;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS send_was_dry_run boolean;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS sent_at timestamptz;

-- Last status observed on the GHL campaign, so a mismatch is visible without
-- replaying issue_events.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS ghl_status text;

-- Partial index for the dual-control count: small, and the predicate matches
-- the query exactly.
CREATE INDEX IF NOT EXISTS issues_production_sent_idx
  ON issues (sent_at)
  WHERE status = 'sent' AND audience_slot = 'production' AND send_was_dry_run = false;

-- Reconcile scans these; in-flight issues are a small slice of the table.
CREATE INDEX IF NOT EXISTS issues_campaign_idx ON issues (ghl_campaign_id);

-- Outbox retry with backoff. A row stays 'pending' between attempts and only
-- becomes 'failed' once it dead-letters, so a transient GHL error no longer
-- burns the issue on the first try.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox (next_attempt_at, created_at)
  WHERE status = 'pending';
