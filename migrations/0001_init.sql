-- B2B Companion — Initial D1 Schema
-- Migration: 0001_init
-- Every table includes shop_id; cross-tenant access is impossible by construction.

CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY,
  shopify_domain TEXT UNIQUE NOT NULL,
  shopify_shop_id INTEGER NOT NULL,
  access_token_encrypted BLOB NOT NULL,
  is_plus BOOLEAN NOT NULL DEFAULT 0,
  plan_id TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  uninstalled_at INTEGER,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_shops_domain ON shops (shopify_domain);

-- ---------------------------------------------------------------------------
-- Tier configuration
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tiers (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'amount', 'none')),
  discount_value REAL NOT NULL DEFAULT 0,
  min_order_value REAL,
  min_order_units INTEGER,
  free_shipping_threshold REAL,
  flat_shipping_amount REAL,
  pickup_only BOOLEAN NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  UNIQUE (shop_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tiers_shop_id ON tiers (shop_id);
CREATE INDEX IF NOT EXISTS idx_tiers_shop_active ON tiers (shop_id) WHERE deleted_at IS NULL;

-- Maps Shopify Companies to our tier rows (mirror of b2b.tier_id metafield)
CREATE TABLE IF NOT EXISTS company_tier_mappings (
  shop_id INTEGER NOT NULL,
  shopify_company_id TEXT NOT NULL,
  tier_id INTEGER NOT NULL REFERENCES tiers(id),
  credit_limit REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (shop_id, shopify_company_id)
);

CREATE INDEX IF NOT EXISTS idx_ctm_shop_id ON company_tier_mappings (shop_id);
CREATE INDEX IF NOT EXISTS idx_ctm_tier_id ON company_tier_mappings (tier_id);

-- ---------------------------------------------------------------------------
-- Wholesale registration applications
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','submitted','approved','rejected','needs_info')),
  form_data_encrypted BLOB NOT NULL,   -- AES-GCM encrypted JSON; per-shop HKDF key
  submitted_at INTEGER,
  decided_at INTEGER,
  decided_by TEXT,
  decision_notes TEXT,
  created_company_id TEXT,            -- Shopify Company GID after approval
  created_location_id TEXT            -- Shopify Company Location GID after approval
);

CREATE INDEX IF NOT EXISTS idx_apps_shop_id ON applications (shop_id);
CREATE INDEX IF NOT EXISTS idx_apps_shop_status ON applications (shop_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_pending_email
  ON applications (shop_id, email) WHERE status IN ('draft', 'submitted', 'needs_info');

-- ---------------------------------------------------------------------------
-- Asset library
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS asset_folders (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL,
  parent_id INTEGER REFERENCES asset_folders(id),
  name TEXT NOT NULL,
  visibility_mode TEXT NOT NULL CHECK (visibility_mode IN ('all_b2b', 'tiers', 'companies')),
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth <= 2),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_asset_folders_shop_id ON asset_folders (shop_id);
CREATE INDEX IF NOT EXISTS idx_asset_folders_parent ON asset_folders (parent_id);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL,
  folder_id INTEGER REFERENCES asset_folders(id),
  type TEXT NOT NULL CHECK (type IN ('image', 'pdf', 'video', 'link')),
  title TEXT NOT NULL,
  description TEXT,
  r2_key TEXT,                        -- R2 object key: shops/<shop_id>/assets/<id>/<variant>
  external_url TEXT,
  file_size_bytes INTEGER,
  mime_type TEXT,
  visibility_mode TEXT NOT NULL CHECK (visibility_mode IN ('all_b2b', 'tiers', 'companies')),
  uploaded_at INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,          -- Shopify staff user email (hashed for logs)
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_assets_shop_id ON assets (shop_id);
CREATE INDEX IF NOT EXISTS idx_assets_folder ON assets (shop_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_assets_shop_active ON assets (shop_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS asset_visibility_rules (
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  rule_type TEXT NOT NULL CHECK (rule_type IN ('tier', 'company')),
  rule_target_id TEXT NOT NULL,       -- tier.id (as text) or Shopify Company GID
  PRIMARY KEY (asset_id, rule_type, rule_target_id)
);

CREATE INDEX IF NOT EXISTS idx_avr_asset_id ON asset_visibility_rules (asset_id);

CREATE TABLE IF NOT EXISTS asset_downloads (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  shopify_company_id TEXT NOT NULL,
  shopify_customer_id TEXT NOT NULL,  -- SHA-256 hash stored, not raw ID (PII)
  downloaded_at INTEGER NOT NULL,
  ip_hash TEXT NOT NULL               -- SHA-256 hash of client IP
);

CREATE INDEX IF NOT EXISTS idx_downloads_shop_id ON asset_downloads (shop_id);
CREATE INDEX IF NOT EXISTS idx_downloads_asset ON asset_downloads (asset_id);
CREATE INDEX IF NOT EXISTS idx_downloads_company ON asset_downloads (shop_id, shopify_company_id);

-- ---------------------------------------------------------------------------
-- Webhook processing log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_log (
  id TEXT PRIMARY KEY,                -- X-Shopify-Webhook-Id (UUID from Shopify)
  shop_id INTEGER NOT NULL,
  topic TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_log_shop_id ON webhook_log (shop_id);
CREATE INDEX IF NOT EXISTS idx_webhook_log_topic ON webhook_log (topic);
CREATE INDEX IF NOT EXISTS idx_webhook_log_status ON webhook_log (status) WHERE status != 'processed';

-- ---------------------------------------------------------------------------
-- Operator audit log (internal ops console — DECISIONS #17)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops_log (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER,                    -- NULL for cross-tenant / global actions
  operator_email TEXT NOT NULL,       -- SSO identity from Cloudflare Access
  action TEXT NOT NULL,               -- e.g. 'webhook.replay', 'tier.update', 'gdpr.audit'
  details_json TEXT,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_log_shop_id ON ops_log (shop_id);
CREATE INDEX IF NOT EXISTS idx_ops_log_operator ON ops_log (operator_email);
CREATE INDEX IF NOT EXISTS idx_ops_log_occurred ON ops_log (occurred_at);
