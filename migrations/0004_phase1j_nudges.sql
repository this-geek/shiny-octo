-- Phase 1J — activation nudge ledger.
-- Tracks which nudge emails (14/30/60 day) have already gone out for an
-- application, so the daily cron can be re-run safely without spamming.
-- Per-row PK is (application_id, kind) — same nudge kind is only ever sent
-- once per application.

CREATE TABLE IF NOT EXISTS application_nudges (
  application_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('nudge_14d', 'nudge_30d', 'nudge_60d')),
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (application_id, kind),
  FOREIGN KEY (application_id) REFERENCES applications(id)
);

CREATE INDEX IF NOT EXISTS idx_application_nudges_sent_at
  ON application_nudges(sent_at);
