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

All subscriptions — GDPR mandatory and otherwise — are declared in `shopify.app.toml` under `[webhooks.privacy_compliance]` and `[[webhooks.subscriptions]]`. They take effect when you run:

```bash
shopify app deploy
```

That command pushes the declarations to Shopify and replaces any subscriptions previously held by the Partner Dashboard. Verify with:

```bash
shopify app info
```

The toml currently subscribes:

| Topic | Why |
|---|---|
| `app/uninstalled` | Mark `shops.uninstalled_at` so we stop using the now-revoked token. |
| `app/scopes_update` | Track scope changes for the re-auth flow. |
| `shop/update` | Refresh `is_plus` when the merchant changes plan. |
| `companies/*`, `company_locations/*` | Invalidate the company hot cache. |
| `customers/create`, `customers/update` | Trigger the wholesale-application linkage. |
| `orders/create`, `orders/updated`, `orders/cancelled` | Analytics + Day-2 credit tracking. |
| `customers/data_request`, `customers/redact`, `shop/redact` | GDPR mandatory (under `[webhooks.privacy_compliance]`). |

Existing installs keep their old subscriptions until you redeploy; new installs pick up whatever is declared in the toml at the time they OAuth.

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

# (Phase 1E) Cloudflare Turnstile — captcha on the wholesale application
# form. Optional: if unset, /application/submit skips captcha verification
# and logs a warning. To enable, create a Turnstile widget at
# https://dash.cloudflare.com/?to=/:account/turnstile and add the
# storefront domain(s) under "Allowed hostnames". Then:
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put TURNSTILE_SITE_KEY  # public, but stored alongside the secret
```

Set the visible "From:" address as a non-secret var in `wrangler.toml`:

```toml
[vars]
EMAIL_FROM = "B2B Companion <hello@yourdomain.com>"
```

The sending domain must be verified at Resend with working DKIM, or
`/application/submit` will skip sending the confirmation email (it logs a
warning instead of failing closed — the buyer still sees the success
response with their reference number).

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
# Local
wrangler d1 execute b2b-companion -c apps/worker/wrangler.toml  --file=migrations/0004_phase1j_nudges.sql --local

# Remote
wrangler d1 execute b2b-companion -c apps/worker/wrangler.toml --file=migrations/0004_phase1j_nudges.sql --remote

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

DECISIONS #6 requires that direct URLs to B2B-only products 404 for guests. The Theme App Embed Block alone cannot do this — only the product template can, and theme app extensions are not allowed to emit the `layout` / `redirect_to` tags this needs. So the snippet ships as merchant copy-paste, not as a bundled extension snippet:

1. In Shopify admin → **Online Store → Themes → Edit code**.
2. Under **Snippets**, click *Add a new snippet*, name it `b2b-product-guard`, and paste:

```liquid
{%- comment -%}
  DECISIONS #6: 404 when product.metafields.b2b.b2b_only is true AND
  customer is not B2B. Include this snippet at the very top of templates/product.liquid.
{%- endcomment -%}
{%- if product.metafields.b2b.b2b_only and customer.b2b? != true -%}
  {%- layout none -%}
  {{ '404' | url_for | redirect_to }}
{%- endif -%}
```

3. Open `templates/product.liquid` (or, for OS 2.0 themes, the JSON template's referenced section) and add this as the **first non-comment line** in the file (above any `<section>` tags or `{%- render %}` calls):

```liquid
{% render 'b2b-product-guard' %}
```

### 10.3 Search & Discovery collection filter recipe

We can't filter collection results server-side from a theme app extension. The primary defence is a Search & Discovery filter rule:

1. Install the **Shopify Search & Discovery** app (free, by Shopify) on the merchant store.
2. Open Search & Discovery → **Filters → Add filter**.
3. Choose **Metafield**, select `b2b.b2b_only` (boolean).
4. Set the filter to **Hide values: true** for the merchant's Online Store sales channel.
5. Verify on a collection page: B2B-only products no longer appear in the grid for guests.

As a CSS-level fallback for themes that don't apply the metafield filter consistently, paste this into `theme.liquid`'s `<head>` (or a snippet named `b2b-collection-filter` that you render from `<head>`):

```liquid
{%- assign customer_is_b2b = false -%}
{%- if customer and customer.b2b? -%}
  {%- assign customer_is_b2b = true -%}
{%- endif -%}
{%- unless customer_is_b2b -%}
  <style>[data-b2b-only="true"] { display: none !important; }</style>
{%- endunless -%}
```

Theme integrators wire each collection-card to set `data-b2b-only="..."` from the per-product metafield.

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

### 10.6 Theme selector preset (B2B Tier Price block)

Themes name their price container and product form differently. The B2B
Tier Price embed needs to know which selectors to target so it can:

1. Hide the price + add-to-cart on `b2b_only` products for non-B2B visitors
   (the server-side `<style>` rule in the Liquid block).
2. Inject the discounted tier price into the right element for approved
   B2B buyers.

The block exposes a **Theme selector preset** setting with four options:

| Preset | Price selector | Form selector | When to use |
|---|---|---|---|
| **Auto (Dawn + Horizon)** | `product-price, .product__price, .price` | `product-form, .product-form, .product-form__buttons` | Default. Works on Dawn, Horizon, and most themes derived from them. |
| **Dawn (and Dawn-derived)** | `.product__price, .price` | `.product-form, .product-form__buttons` | Pick this on Dawn / Sense / Crave / Refresh / Studio / Taste / Trade / Colorblock if Auto matches too eagerly. |
| **Horizon** | `product-price` | `product-form` | Pick this on Horizon (custom elements) for the tightest match. |
| **Custom selectors** | (you provide) | (you provide) | For any other theme. Paste CSS selectors into the two text fields. |

**If the selector matches no element on the page, the block logs a
`[b2b-price]` warning in the browser console and does nothing.** It does
not fall back to a default — silent rendering into the wrong place is what
this setting exists to prevent.

#### Finding the right selectors for a custom theme

1. Open a product page on the storefront.
2. Right-click the **displayed price** → **Inspect**.
3. In the Elements panel, walk up the DOM tree to find the smallest
   container that wraps **only** the price (and its `regular`/`sale`
   variants if the theme has them). Note its tag, classes, or `data-*`
   attributes. Example targets:
   - `<product-price>` (custom element) → use `product-price`.
   - `<div class="price-block">` → use `.price-block`.
   - `<span data-product-price>` → use `[data-product-price]`.
4. Right-click the **add-to-cart button** → **Inspect**. Walk up to the
   wrapping `<form>` or custom element that contains both the quantity
   input and the buy button.
5. In the block settings, set **Theme selector preset** to **Custom
   selectors** and paste each value into the matching text field.
6. Save the theme and reload the product page. Open DevTools → Console
   and confirm there is no `[b2b-price]` warning. If there is, the
   selector matched nothing; re-check the spelling.

A future public-facing support site will host per-theme recipes
(screenshot + ready-to-paste selectors). Until then, contributions to
this table are welcome via PR.

### 10.7 Site-wide tier pricing (Phase 1K)

By default the tier price is only refined on the product page. To show it
across collections, search results, the home page, and the cart drawer:

1. In the embedded app → **Settings → Price display**, turn on **Show tier
   pricing across the whole store**. Pick the display mode (alongside vs
   replace) and whether to show the savings badge, then **Save**. This writes
   the `b2b.price_display` Shop metafield that the storefront embed reads — no
   theme edit required.
2. **Require login (strongly recommended).** In **Online Store → Preferences →
   Restrict store access**, enable **require login / B2B login**. With it on
   there are no anonymous visitors, so tier prices render on first paint and
   never flash to the public. Without it, only logged-in B2B buyers see tier
   prices; everyone else sees your public prices (still safe, just not gated).
3. The overlay reuses the **Theme selector preset** from §10.6 to find price
   containers on listing pages. If listing-card prices aren't being refined,
   switch to **Custom selectors** and add the card's price selector (e.g.
   Dawn's `.price`).

Notes:

- **Both percent and fixed-amount tiers** are supported site-wide; the overlay
  applies exactly what checkout applies.
- **Shopify Plus:** the overlay is automatically disabled (native Catalogs do
  the pricing), the same way the discount Function is — no action needed.
- The overlay only ever **lowers** a displayed price and skips anything it
  can't parse, so it's safe to leave on across all templates.

### 10.8 Verify checklist (Phase 1K site-wide — manual)

- [ ] With site-wide on, an approved B2B buyer sees the tier price on a
      collection page, in search results, and on the home page — matching the
      PDP and the price at checkout.
- [ ] The cart drawer shows the tier price after adding an item (AJAX surface).
- [ ] A guest / non-B2B customer sees public prices everywhere (no discount).
- [ ] On a Plus dev store, no tier discount is shown anywhere on the storefront.

---

## 11. Deploying the Embedded Admin (Cloudflare Pages)

The Worker remains the OAuth + webhook + `/admin/*` API host. The Pages project is the embedded admin UI loaded by Shopify in the merchant's admin iframe.

### 11.1 One-time setup

```bash
cd apps/admin
pnpm build
wrangler pages project create b2b-companion-admin --production-branch=main
wrangler pages secret put SHOPIFY_API_KEY --project-name=b2b-companion-admin
```

`SHOPIFY_API_KEY` is the same Client ID used by the Worker — App Bridge needs it client-side so the `<meta name="shopify-api-key">` tag in `root.tsx` resolves to a real value.

### 11.2 Deploy

```bash
cd apps/admin
pnpm build && pnpm pages:deploy
```

Wrangler prints the deployed URL, e.g. `https://b2b-companion-admin.pages.dev`.

> **Note:** the script is `pages:deploy` (not `deploy`) because pnpm 8+ reserves the bare word `pnpm deploy` for its own workspace-deploy command and it cannot be overridden by a package script. Same reason `pages:dev` (local emulator) is namespaced rather than `start`.

### 11.3 Update Partner dashboard URLs

> **Critical**: the **App URL** must point at the Pages site, not the Worker. The Worker's `/auth` is the OAuth install endpoint — it always redirects to `accounts.shopify.com`, which sets `X-Frame-Options: DENY`. If you leave App URL pointed at `<worker>/auth`, the embedded iframe will refuse to load with `Refused to display 'https://admin.shopify.com/' in a frame` and an App Bridge `postMessage` origin mismatch.

In the app's **App setup** page, set **only** the App URL — leave the other two fields on the Worker:

| Field | New value | Note |
|---|---|---|
| **App URL** | `https://b2b-companion-admin.pages.dev/` | **Change this.** Trailing slash matters; this is where the embedded iframe loads. |
| Allowed redirection URL(s) | `https://<your-worker-subdomain>.workers.dev/auth/callback` | **Unchanged** — OAuth callback stays on the Worker. |
| App Proxy → Proxy URL | `https://<your-worker-subdomain>.workers.dev/proxy` | **Unchanged** — Phase 1B. |

Install flow after this change: Shopify → `<worker>/auth?shop=...` → OAuth callback → redirect to `https://{shop}/admin/apps/{api_key}` → Shopify loads `<pages>/?host=...&shop=...&embedded=1&id_token=...` in the iframe.

### 11.4 Do **not** change `APP_URL` in `wrangler.toml`

`APP_URL` in the Worker is used only to build the OAuth `redirect_uri` (`${APP_URL}/auth/callback`), which must match the **Allowed redirection URL(s)** field above. It must remain the Worker URL:

```toml
[vars]
APP_URL = "https://b2b-companion.selling.workers.dev"
```

Pointing it at the Pages URL would break OAuth — Shopify would send the callback to a host with no `/auth/callback` route.

### 11.5 Worker CORS

The Tiers, Companies, and Settings admin pages fetch `<worker>/admin/*` directly from the browser (App Bridge injects the session token), so the Worker must allowlist the Pages origin.

Set `ADMIN_ORIGIN` on the Worker to your Pages URL — already wired into `apps/worker/wrangler.toml`:

```toml
[vars]
ADMIN_ORIGIN = "https://b2b-companion-admin.pages.dev"
```

For a staging Pages site, comma-separate: `ADMIN_ORIGIN = "https://b2b-companion-admin.pages.dev,https://staging.b2b-companion-admin.pages.dev"`.

The middleware (`apps/worker/src/middleware/cors.ts`) handles the OPTIONS preflight before the session-token check and echoes the origin only if it matches the allowlist. Unset = no CORS headers ever — safe default that breaks browser calls until you configure it.

### 11.6 Deferred

- Full App Bridge React provider wiring (`<Provider>` + `useAppBridge()` token refresh on every loader). The CDN script + `<meta name="shopify-api-key">` is the minimum Shopify needs to treat this as a valid embedded app; the loader currently reads `id_token` from the URL search params, which is fine for the initial render but won't survive token expiry.

### 11.7 Verify checklist

- [ ] `https://b2b-companion-admin.pages.dev/?shop=test.myshopify.com&host=dGVzdA` returns 200 with a Polaris page (no real data without a valid `id_token`).
- [ ] Install from the Partner dashboard → after OAuth, the embedded iframe loads the Pages site without `X-Frame-Options` blocking it.
- [ ] For Plus shops, the Plus banner appears; dismissing it persists.
- [ ] DevTools → Network → admin loader request shows `Authorization: Bearer <id_token>` going to the Worker URL.
- [ ] Response headers on the Pages document include `Content-Security-Policy: frame-ancestors https://*.myshopify.com https://admin.shopify.com`.

---

## 12. Phase 1C: Dealer asset portal

Required after the Phase 1C Worker + Pages + Theme App Extension code is deployed.

### 12.1 Prerequisites

- R2 bucket `b2b-companion-assets` exists (created in §3.3).
- Phase 1B App Proxy is configured (the buyer block calls `/apps/<prefix>/assets/list` over it).

No extra secrets are needed — the asset portal uses the existing `ASSETS_BUCKET` binding for both uploads (multipart via the Worker) and downloads (streamed via the Worker). R2 objects are never given out as public URLs.

### 12.2 Enable the buyer "Dealer Assets" block on the theme

The block `extensions/theme-app-extension/blocks/b2b-assets.liquid` ships with the existing Theme App Extension. After `shopify app deploy`:

1. Shopify admin → **Online Store → Themes → Customize**.
2. Open the page where you want dealer assets visible — typically the customer account page (template `customers/account`) or a dedicated B2B portal page.
3. Click **Add section → Apps → B2B Dealer Assets**.
4. Save the theme.

The block renders nothing for guests, a "B2B only" notice for non-B2B customers, and the searchable asset list for approved B2B buyers. The list comes from `GET /apps/<prefix>/assets/list`; downloads stream through `GET /apps/<prefix>/assets/download/:id` (the buyer never sees an R2 URL).

### 12.3 Configure the fair-use ceiling

The 250 GB/shop/month ceiling (DECISIONS #14) is hard-coded in `apps/worker/src/lib/bandwidth-counter.ts::CAP_BYTES`. The bucket key is `bw:<shop_id>:<YYYY-MM>` in the `KV_HOT_CACHE` namespace. To inspect usage for a shop:

```bash
wrangler kv key get --binding=KV_HOT_CACHE "bw:7:2026-05"
```

To reset a shop's counter (e.g. after a billing dispute):

```bash
wrangler kv key delete --binding=KV_HOT_CACHE "bw:7:2026-05"
```

When the cap is hit, `GET /assets/download/:id` returns HTTP 429 with `{"error": "monthly download limit reached; contact the merchant"}` and the merchant has to wait for the calendar month to roll over (or the operator clears the bucket manually).

### 12.4 R2 object lifecycle

- **Uploads**: admin calls `POST /admin/assets/uploads` to start a multipart session. Parts (≤95 MiB each) PUT to `/admin/assets/uploads/:sessionId/parts/:n`. Once complete is called, the canonical R2 key is `shops/<shop_id>/assets/<asset_id>/original` (after `POST /admin/assets/:id/finalise-upload` server-side-copies from the temp upload path to the canonical key).
- **Soft delete**: the D1 row gets `deleted_at` but the R2 object stays in place. A nightly cron to hard-delete R2 objects whose D1 rows have been soft-deleted >30 days is a Day-2 follow-up; for now the recovery window is unbounded.
- **GDPR `shop/redact`**: the existing handler should be extended in Phase 2 to walk `assets.r2_key` and delete the R2 objects after the 48h grace.

### 12.5 Verify checklist (Phase 1C acceptance — manual)

- [ ] Merchant uploads a small PDF in `/assets`, sees it appear in the list.
- [ ] Merchant uploads a >100MB file: upload completes (multipart chunking), the asset row appears, and the bytes land at `shops/<shop_id>/assets/<id>/original` in R2.
- [ ] A buyer in tier A can download an asset whose visibility is "tier A only"; the same buyer gets 404 on an asset visible only to tier B.
- [ ] A guest hitting `/apps/<prefix>/assets/list` over the App Proxy gets `{ "assets": [] }` (signature still verifies, but the buyer isn't B2B).
- [ ] A buyer hitting `/apps/<prefix>/assets/download/:id` for an asset they can see gets a streamed download with `Content-Disposition: attachment` and `Cache-Control: private, no-store`.
- [ ] The KV bucket `bw:<shop_id>:<YYYY-MM>` increments by approximately the downloaded file size after each download.
- [ ] After the cap is set to a small value in a local override and exceeded, the next download returns HTTP 429.
- [ ] R2 bucket browser shows no public/presigned URLs were ever issued — all access is via the Worker.

### 12.6 Deferred (Day 2 / Phase 2)

- **Cloudflare Images variant generation** (DECISIONS #2). Buyer list serves the `original` variant for images today. To wire variants: enable Cloudflare Images, store the Account ID + API token as Worker secrets, add a queue job that POSTs the uploaded image to Images on `finalise-upload` completion, and persist the resulting variant URL(s) on the asset row (small schema migration needed).
- **Zip-stream bulk download**. Needs a streaming-zip implementation in the Worker so we don't buffer N files in memory.
- **Drag-and-drop uploader**. Today the admin uses the file picker.
- **Bulk tag**. Needs an `asset_tags` table (no schema today).
- **R2 hard-delete cron** for soft-deleted assets older than 30 days.

## 13. Dealer portal link block (DECISIONS #18)

The buyer-facing portal is rendered by the Worker and served via Shopify App Proxy at `<shop-domain>/apps/<proxy-subpath>/portal` (the subpath comes from `shopify.app.toml -> [app_proxy] -> subpath`, default `b2b`). The customer-account UI extension `b2b-portal-link` is a single-target block (`customer-account.order-index.block.render`) whose only job is to surface a link to that portal from inside the customer account chrome.

After `shopify app deploy` lands the extension, **the merchant must paste the portal URL into the block's settings** — the block renders nothing until they do.

### 13.1 Configure the link block per shop

1. Shopify admin → **Settings → Customer accounts → Customize** (the "Manage" or "Customize order status" entry that opens the customer-account theme editor).
2. Navigate to the **Order index** page in the left rail.
3. Click **Add block → Apps → B2B Dealer Portal Link**.
4. In the block's settings, set:
   - **Portal URL** — required. Full URL on the shop's domain, e.g. `https://your-shop.myshopify.com/apps/b2b/portal`. Must match `[app_proxy] -> prefix + subpath` in `shopify.app.toml` followed by `/portal`. If you use a custom primary domain, use that instead of `myshopify.com`.
   - **Card heading** — optional. Defaults to "Dealer portal".
   - **Call-to-action label** — optional. Defaults to "Open dealer portal".
5. **Save** the customer-account customisation.

### 13.2 Verify

- Sign in as a B2B buyer (a customer attached to a Shopify Company).
- Open **My account → Orders**.
- The "Dealer portal" card should be visible with the configured CTA.
- Click the CTA. You should land on `<shop>/apps/b2b/portal` showing the Assets / Profile tabs and (on first visit) the welcome tour.
- Sign in as a non-B2B customer. The card is still visible (Shopify renders blocks for all buyers), but clicking through lands on the "not enabled for this account" page served by the Worker.

### 13.3 Why this is a manual step

Every merchant has a different shop domain (or a custom primary domain) and may run multiple stores from one app install, so the portal URL can't be hard-coded into the block. It's a one-time setting per shop — add it to your merchant onboarding checklist. The block intentionally renders nothing when the URL is empty so a half-installed app doesn't expose a broken link to buyers.

