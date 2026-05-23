-- Phase 1A — admin state additions
-- Tracks whether the Plus-mode informational banner has been dismissed
-- by an admin user. NULL = never dismissed; epoch seconds = when dismissed.
ALTER TABLE shops ADD COLUMN plus_banner_dismissed_at INTEGER;
