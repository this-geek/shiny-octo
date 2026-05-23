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
}
