-- Phase 2 — GDPR request queue.
-- One row per Shopify privacy webhook (customers/data_request,
-- customers/redact, shop/redact) plus an internal `app_uninstall_purge`
-- kind enqueued by the app/uninstalled handler. The daily cron sweeps
-- rows whose due_at has passed and either exports or purges, then marks
-- them completed. A 7-day stand-down on redacts gives staff a window
-- to cancel an accidental request via the admin UI.

CREATE TABLE IF NOT EXISTS gdpr_requests (
  -- For Shopify-originated requests we reuse X-Shopify-Webhook-Id so the
  -- existing idempotency check at the receive layer guarantees no
  -- duplicate row. Internal enqueues mint their own id.
  id                   TEXT PRIMARY KEY,
  -- Nullable: a shop/redact may arrive after the shops row has already
  -- been purged by a prior app_uninstall_purge. The shop_domain field
  -- is denormalised so the sweep can still locate R2 objects.
  shop_id              INTEGER,
  shop_domain          TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN (
                         'customer_data_request',
                         'customer_redact',
                         'shop_redact',
                         'app_uninstall_purge'
                       )),
  -- Populated for customer-scoped kinds; NULL for shop-scoped kinds.
  shopify_customer_id  TEXT,
  payload_json         TEXT NOT NULL,
  received_at          INTEGER NOT NULL,
  due_at               INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                         'pending',
                         'processing',
                         'completed',
                         'cancelled',
                         'failed'
                       )),
  completed_at         INTEGER,
  last_error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_gdpr_requests_due
  ON gdpr_requests (status, due_at);

CREATE INDEX IF NOT EXISTS idx_gdpr_requests_shop
  ON gdpr_requests (shop_id);
