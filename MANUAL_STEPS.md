# Manual Setup Steps

Everything in this file requires human action. No automated tooling can do it for you.

---

## 1. Prerequisites

Before writing any code or running any commands, confirm you have:

| Tool | Minimum version | Check |
|---|---|---|
| Node.js | 22.x | `node --version` |
| pnpm | 10.x | `pnpm --version` |
| Wrangler CLI | 3.x | `wrangler --version` |
| Shopify CLI | 3.x | `shopify version` |
| Git | 2.x | `git --version` |

**Accounts required:**

- **Shopify Partner account** — https://partners.shopify.com/signup
- **Cloudflare account** (free tier is fine for development) — https://dash.cloudflare.com/sign-up
- **Resend account** (for transactional email) — https://resend.com/signup

---

## 2. Shopify App Setup

### 2.1 Create the app in Partner Dashboard

1. Log in to https://partners.shopify.com
2. Click **Apps → Create app → Create app manually**
3. Set **App name**: `B2B Companion` (or your merchant-facing name)
4. Record the **Client ID** (API key) and **Client secret** — you'll need these in step 4

### 2.2 Configure URLs

In the app's **App setup** page:

| Field | Value |
|---|---|
| App URL | `https://<your-worker-subdomain>.workers.dev/auth` |
| Allowed redirection URL(s) | `https://<your-worker-subdomain>.workers.dev/auth/callback` |

> Note: Update these after your first `wrangler deploy` once you know the actual worker URL.

### 2.3 Webhook subscriptions

In **App setup → Webhooks**, add subscriptions for each topic listed in `wrangler.toml`:
- `app/uninstalled`
- `shop/update`
- `companies/create`, `companies/update`, `companies/delete`
- `company_locations/create`, `company_locations/update`
- `customers/create`, `customers/update`
- `customers/data_request` (GDPR — mandatory)
- `customers/redact` (GDPR — mandatory)
- `shop/redact` (GDPR — mandatory)
- `orders/create`, `orders/updated`, `orders/cancelled`
- `app/scopes_update`

Webhook endpoint URL: `https://<your-worker-subdomain>.workers.dev/webhooks`

### 2.4 App scopes

In **App setup → API access**, confirm the following scopes are requested:

```
read_customers, write_customers, read_products, write_products,
read_orders, write_orders, read_companies, write_companies,
read_company_locations, write_company_locations,
read_companies_buyer_experience_configurations,
read_files, write_files, read_themes, write_themes, read_locales,
read_payment_terms, write_payment_terms, read_markets,
read_shipping, write_shipping
```

These are set in `apps/worker/src/routes/oauth.ts` (the `SCOPES` constant).

---

## 3. Cloudflare Resources

All commands below assume you're logged in: `wrangler login`

### 3.1 D1 Database

```bash
wrangler d1 create b2b-companion
```

Copy the `database_id` from the output and paste it into `apps/worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "b2b-companion"
database_id = "PASTE_YOUR_DATABASE_ID_HERE"
```

### 3.2 KV Namespaces (create three)

```bash
wrangler kv namespace create KV_SESSIONS
wrangler kv namespace create KV_IDEMPOTENCY
wrangler kv namespace create KV_HOT_CACHE
```

Each command outputs an `id`. Paste each into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV_SESSIONS"
id = "PASTE_KV_SESSIONS_ID"

[[kv_namespaces]]
binding = "KV_IDEMPOTENCY"
id = "PASTE_KV_IDEMPOTENCY_ID"

[[kv_namespaces]]
binding = "KV_HOT_CACHE"
id = "PASTE_KV_HOT_CACHE_ID"
```

### 3.3 R2 Bucket

```bash
wrangler r2 bucket create b2b-companion-assets
```

No ID needed — R2 buckets are referenced by name. Confirm `wrangler.toml` has:

```toml
[[r2_buckets]]
binding = "ASSETS_BUCKET"
bucket_name = "b2b-companion-assets"
```

### 3.4 Queue

```bash
wrangler queues create b2b-webhook-queue
```

Confirm `wrangler.toml` has the producer and consumer configuration (already present in the checked-in file).

### 3.5 Cloudflare Images (optional for Phase 0)

Enable Cloudflare Images from the Cloudflare dashboard under your account's **Images** section. Note the **Account ID** and **Images API token** — you'll need these in Phase 2 for asset upload processing.

---

## 4. Secrets

Set each secret using Wrangler. **Never commit these to the repo.**

```bash
# Shopify app credentials (from step 2.1)
wrangler secret put SHOPIFY_API_KEY
wrangler secret put SHOPIFY_API_SECRET

# 256-bit AES-GCM master key for per-shop HKDF derivation
# Generate with:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
wrangler secret put MASTER_KEY

# Resend API key for transactional email
wrangler secret put RESEND_API_KEY
```

> **MASTER_KEY rotation**: If you rotate this key, all existing encrypted tokens in D1 become unreadable. Plan a migration procedure (re-encrypt all rows with new key) before rotating in production.

---

## 5. Local Development

### 5.1 Install dependencies

```bash
cd /path/to/shiny-octo
pnpm install
```

### 5.2 Create local environment file

```bash
cp .env.example .env
```

Edit `.env` with your Shopify app credentials for local development. (`.env` is git-ignored.)

> `.env.example` is not yet created — create it with the following contents:
> ```
> SHOPIFY_API_KEY=your_api_key_here
> SHOPIFY_API_SECRET=your_api_secret_here
> MASTER_KEY=your_256_bit_hex_key_here
> RESEND_API_KEY=your_resend_key_here
> ```

### 5.3 Run the D1 migration locally

```bash
wrangler d1 execute b2b-companion --local --file=migrations/0001_init.sql
```

### 5.4 Start local development

```bash
# Worker (Cloudflare Workers with local emulation)
pnpm --filter @b2b/worker dev

# Or all workspaces in parallel (where applicable)
pnpm dev
```

Wrangler runs the worker at `http://localhost:8787` by default.

---

## 6. First Deploy

### 6.1 Run the production migration

```bash
wrangler d1 execute b2b-companion --file=migrations/0001_init.sql
```

### 6.2 Deploy the worker

```bash
wrangler deploy
```

Copy the deployed URL (e.g. `https://b2b-companion.your-subdomain.workers.dev`).

### 6.3 Update Shopify App URLs

Go back to the Partner Dashboard (step 2.2) and update:
- **App URL** → `https://b2b-companion.your-subdomain.workers.dev/auth`
- **Allowed redirection URL** → `https://b2b-companion.your-subdomain.workers.dev/auth/callback`

Also update `wrangler.toml`:
```toml
[vars]
APP_URL = "https://b2b-companion.your-subdomain.workers.dev"
```

---

## 7. Shopify CLI & Dev Store

### 7.1 Connect to your app

```bash
shopify app dev
```

Shopify CLI will prompt you to:
1. Select your Partner organisation
2. Select or create a development store
3. Confirm your app

### 7.2 Install on dev store

Follow the OAuth flow that `shopify app dev` initiates. The app will install on your development store, triggering the OAuth callback at `https://<your-worker>.workers.dev/auth/callback`.

---

## 8. Verify Install → Uninstall Round-Trip

Run through this checklist manually after first deploy:

- [ ] Visit `https://<your-worker>.workers.dev/auth?shop=<your-dev-store>.myshopify.com`
- [ ] OAuth redirect to Shopify login/consent screen appears
- [ ] After approval, redirected to `https://<dev-store>.myshopify.com/admin/apps/<api-key>`
- [ ] D1 `shops` table has a row for the dev store (`wrangler d1 execute b2b-companion --command "SELECT shopify_domain, is_plus, installed_at FROM shops"`)
- [ ] `access_token_encrypted` column is not null and is base64-encoded ciphertext (not a raw token)
- [ ] Health check returns 200: `curl https://<your-worker>.workers.dev/health`
- [ ] Uninstall the app from the Shopify admin (Apps → Uninstall)
- [ ] `app/uninstalled` webhook fires (check worker logs: `wrangler tail`)
- [ ] D1 `shops.uninstalled_at` is now set for that row
- [ ] Reinstall the app — `shops.uninstalled_at` is cleared, `installed_at` is not changed

---

## 9. Pilot Merchant Constants (DECISIONS #12)

Before starting Phase 1, confirm the following facts about the pilot merchant with them directly:

| Constant | Value | Status |
|---|---|---|
| Location | New Zealand | Confirmed in DECISIONS #12 |
| Shopify plan | Advanced (not Plus) | Confirm before Phase 1 — affects Function behaviour |
| Theme | Dawn-based | Confirm the exact theme version for Phase 1B testing |
| Existing wholesale customers | ~20, tagged `wholesale` | Confirm before Phase 1A migration wizard |
| Tax ID format | NZ IRD/GST (9-digit) | Confirm before Phase 1 registration form |
| Email sending domain | TBD | Set up Resend domain and confirm DNS before Phase 1 |

**Action items before Phase 1:**
1. Schedule a 30-minute call with the pilot merchant to confirm all constants above.
2. Get read access to their Shopify admin to audit their existing Companies/Catalogs/Customers.
3. Confirm their Dawn theme version and whether they use any apps that might conflict with our Theme App Extension.
4. Agree on the pilot launch date and the first set of test B2B customers.
