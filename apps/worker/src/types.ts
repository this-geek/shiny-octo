export interface Env {
  DB: D1Database;
  KV_SESSIONS: KVNamespace;
  KV_IDEMPOTENCY: KVNamespace;
  KV_HOT_CACHE: KVNamespace;
  ASSETS_BUCKET: R2Bucket;
  WEBHOOK_QUEUE: Queue;
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  MASTER_KEY: string;
  RESEND_API_KEY: string;
  APP_URL: string;
  SHOPIFY_API_VERSION: string;
  ADMIN_ORIGIN: string;
  // Phase 1E. Optional; the buyer-side form-config endpoint exposes the
  // public site key to the storefront when both are present.
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  // Verified Resend sending domain — the From: address for application
  // emails. Must be a domain you control with valid DKIM at Resend.
  EMAIL_FROM?: string;
  // Phase 2 — Cloudflare Access for /_ops/*. Both must be set; if either
  // is missing the ops console refuses every request (no header-only
  // fallback). See DECISIONS #17.
  OPS_ACCESS_TEAM?: string;
  OPS_ACCESS_AUD?: string;
}
