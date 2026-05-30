-- Phase 2 — Merchant-scope audit log.
-- One row per privileged merchant action: application decisions, tier
-- create/update/delete, company-tier mapping changes, asset visibility
-- changes. Distinct from `ops_log` (Cloudflare-Access SSO operator
-- console) — that table carries operator identity for cross-tenant
-- support actions; this one carries the Shopify staff user identity
-- from the session JWT for actions the merchant performed themselves.
--
-- `entity_id` is TEXT so it can hold either a D1 numeric id (tier,
-- application, asset) or a Shopify GID (company_tier_mapping). Bad
-- enough that this would otherwise need two columns.

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY,
  shop_id       INTEGER NOT NULL,
  actor         TEXT NOT NULL,           -- session-token sub (Shopify staff user GID)
  action        TEXT NOT NULL,           -- e.g. 'application.approve', 'tier.create'
  entity_type   TEXT NOT NULL,           -- 'application' | 'tier' | 'company_mapping' | 'asset'
  entity_id     TEXT NOT NULL,
  details_json  TEXT,                    -- compact JSON; before/after diff or context
  occurred_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_shop_time
  ON audit_log (shop_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON audit_log (shop_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON audit_log (shop_id, actor);
