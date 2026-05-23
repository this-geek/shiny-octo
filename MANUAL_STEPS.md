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

Shopify splits webhooks into two categories with different setup paths.

#### GDPR mandatory webhooks (Partner Dashboard)

Go to your app → **Configuration** → **GDPR mandatory webhooks**. Set the endpoint URL for each of the three required topics:

| Topic | Endpoint |
|---|---|
| `customers/data_request` | `https://<your-worker-subdomain>.workers.dev/webhooks` |
| `customers/redact` | `https://<your-worker-subdomain>.workers.dev/webhooks` |
| `shop/redact` | `https://<your-worker-subdomain>.workers.dev/webhooks` |

There is no UI in the Partner Dashboard for any other webhook topics.

#### All other webhooks (registered programmatically)

All non-GDPR webhooks must be registered via the Admin GraphQL API (`webhookSubscriptionCreate` mutation) after OAuth install completes. The post-install handler in `apps/worker/src/routes/oauth.ts` is responsible for registering:

- `app/uninstalled`
- `shop/update`
- `companies/create`, `companies/update`, `companies/delete`
- `company_locations/create`, `company_locations/update`
- `customers/create`, `customers/update`
- `orders/create`, `orders/updated`, `orders/cancelled`
- `app/scopes_update`

> Note: The programmatic registration logic has not been implemented yet — it is part of Phase 0 OAuth completion work.

### 2.4 App scopes

In **App setup → API access**, confirm the following scopes are requested:

```
read_customers, write_customers, read_products, write_products,
read_orders, write_orders, read_companies, write_companies,
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

---

## 10. Phase 1B: Gated catalog setup

These steps complete the §4.1 gated-catalog feature for one merchant. Required after the Phase 1B Worker code is deployed.

### 10.1 Configure the App Proxy

Required so the storefront can call `/tier-context` and future buyer endpoints under the merchant's own domain.

In Partner Dashboard → your app → **App setup → App Proxy**:

| Field | Value |
|---|---|
| Subpath prefix | `apps` |
| Subpath | `b2b` *(or the merchant's preferred subpath — Worker reads it back from `shops.settings_json.app_proxy.subpath`, DECISIONS #9)* |
| Proxy URL | `https://<your-worker-subdomain>.workers.dev/proxy` |

Shopify will forward `/apps/b2b/*` on the storefront to `https://<worker>/proxy/*` and append the signed `signature` query parameter. The Worker's `appProxyMiddleware` verifies it.

The Shop metafield `b2b.app_proxy_path` is written automatically on install with the default value `apps/b2b`. If you change the subpath above, update the metafield to match (the storefront JS uses it to build the fetch URL).

### 10.2 Add the product-template 404 guard snippet

DECISIONS #6 requires that direct URLs to B2B-only products 404 for guests. The Theme App Embed Block alone cannot do this — only the product template can. Edit the merchant's theme:

1. In Shopify admin → **Online Store → Themes → Edit code**.
2. Open `templates/product.liquid` (or, for OS 2.0 themes, the JSON template's referenced section).
3. Add this as the **first non-comment line** in the file (above any `<section>` tags or `{%- render %}` calls):

```liquid
{% render 'b2b-product-guard' %}
```

The snippet ships with our Theme App Extension under `snippets/b2b-product-guard.liquid`.

### 10.3 Search & Discovery collection filter recipe

We can't filter collection results server-side from a theme app extension. The primary defence is a Search & Discovery filter rule:

1. Install the **Shopify Search & Discovery** app (free, by Shopify) on the merchant store.
2. Open Search & Discovery → **Filters → Add filter**.
3. Choose **Metafield**, select `b2b.b2b_only` (boolean).
4. Set the filter to **Hide values: true** for the merchant's Online Store sales channel.
5. Verify on a collection page: B2B-only products no longer appear in the grid for guests.

As a CSS-level fallback for themes that don't apply the metafield filter consistently, include the snippet `b2b-collection-filter.liquid` once in `theme.liquid`'s `<head>`. It hides collection cards carrying `data-b2b-only="true"` when the visitor is not a B2B customer.

### 10.4 Enable the Theme App Embed Block

1. In Shopify admin → **Online Store → Themes → Customize**.
2. Open the **App embeds** panel (left rail, puzzle icon).
3. Enable **B2B Tier Price**.
4. Save the theme.

### 10.5 Verify checklist (Phase 1B acceptance — manual)

- [ ] A B2B-only product 404s when visited via direct URL while logged out.
- [ ] The same product 404s when visited as a non-B2B logged-in customer.
- [ ] The same product renders normally with discounted price when visited as an approved B2B buyer.
- [ ] No price FOUC on any of Dawn, Horizon, Impulse, Prestige (open DevTools → Network → throttling Fast 3G).
- [ ] Tier-price refinement completes within 500ms of login on a cached page load.
- [ ] Collection pages do not surface B2B-only product cards to guests.
- [ ] Search & Discovery search results do not surface B2B-only products to guests.
