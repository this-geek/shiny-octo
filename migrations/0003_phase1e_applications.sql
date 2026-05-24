-- Phase 1E — wholesale application state additions
-- The base applications table (0001) already has the encrypted-payload column,
-- status enum, and the GraphQL ids we write on approve. These additions cover:
--   - created_at: drives the 14-day draft TTL for resume tokens.
--   - last_autosaved_at: surfaces "draft from 3h ago" in the buyer UI.
--   - shopify_customer_id: set on approve so a subsequent customers/update
--     webhook can correlate.

ALTER TABLE applications ADD COLUMN created_at INTEGER;
ALTER TABLE applications ADD COLUMN last_autosaved_at INTEGER;
ALTER TABLE applications ADD COLUMN shopify_customer_id TEXT;

-- Existing rows (there are none in production at the time of this migration)
-- would have NULL created_at; readers treat that as the row's submitted_at or
-- 0 if both are NULL.
