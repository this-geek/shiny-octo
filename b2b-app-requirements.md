# B2B Wholesale Companion — Requirements

**Status:** Working draft v0.2
**Audience:** Claude Code (implementation) and any human collaborators
**Last updated:** 2026-05-30

---

## 1. Project Overview

A Shopify public app that augments Shopify's native B2B features (rolled out to all paid plans on 2026-04-02) to fill the gaps real wholesalers hit at scale. It is explicitly **not** a wholesale-from-scratch app — it sits on top of Shopify Companies, Catalogs and Markets and adds the missing pieces.

The product is being built around a real pilot merchant who needs the functionality immediately. Pilot delivery comes first; the App Store-ready public version follows.

### Strategic positioning

- **Augments, never replaces** Shopify's native B2B primitives.
- **Differentiator is the dealer asset portal**, which no incumbent does well. Price-gating and tier-pricing are table stakes; we ship them but do not lead with them.
- **Works on Basic / Grow / Advanced / Plus**, with logic that gracefully steps aside on Plus where native already covers the use case.

### Non-goals

- We do not build a parallel "company" data model. Shopify is the source of truth.
- We do not build payment processing. Net terms ride on Shopify's native flows.
- We do not build a separate storefront. Buyers use the merchant's normal store, gated.
- We do not target replatforming from Magento / WooCommerce / SAP. Pure Shopify-native.

---

## 2. Architecture

### Tech stack

- **Runtime:** Cloudflare Workers (Hono framework)
- **Relational store:** D1 (per-shop logical separation by `shop_id` column; consider per-shop databases at scale)
- **KV:** session tokens, idempotency keys, hot caches (catalog membership, tier lookups)
- **Queues:** webhook fan-out, async approval emails, asset processing, deferred analytics
- **R2:** dealer asset storage (logos, photography, PDFs, videos), signed-URL access
- **Storefront layer:** Theme App Extension (App Embed Block + App Block for the asset portal page); zero hard-coded theme assumptions
- **Shopify Functions:** cart-transform (tier discounts), cart-validation (minimums, step qty), delivery-customization (per-tier shipping)
- **Admin UI:** Polaris React, embedded via App Bridge 4
- **Auth:** Shopify OAuth 2.0 for shops; Shopify session tokens for embedded admin requests; Shopify Customer Account API for buyer-side identity

### Cross-cutting requirements

- **Webhook discipline:** Raw-body HMAC verification *before* parsing. Idempotent handlers keyed by `X-Shopify-Webhook-Id`. Replay must be safe.
- **Encryption at rest:** Per-shop HKDF-derived AES-GCM keys for any token, API credential, or PII stored in D1. Master key in Cloudflare secrets.
- **Tenant isolation:** Every D1 query, every R2 path, every KV key includes `shop_id`. No cross-tenant query is possible by construction.
- **Versioned GraphQL:** Pin to a specific Admin API version. Update on a deliberate cadence; never `unstable`.
- **No PII in logs.** Structured logging with shop ID, customer ID hashes only.

### Required Shopify scopes

- `read_customers`, `write_customers`
- `read_products`, `write_products` (for metafield management)
- `read_orders`, `write_orders`
- `read_companies`, `write_companies` (B2B)
- `read_company_locations`, `write_company_locations`
- `read_companies_buyer_experience_configurations`
- `read_files`, `write_files`
- `read_themes`, `write_themes` (for theme app extension support)
- `read_locales`
- `read_payment_terms`, `write_payment_terms`
- `read_markets`
- `read_shipping`, `write_shipping`

Document why each scope is required in the App Store listing — Built for Shopify reviewers will challenge this.

### Webhooks subscribed

`app/uninstalled`, `shop/update`, `companies/create`, `companies/update`, `companies/delete`, `company_locations/create`, `company_locations/update`, `customers/create`, `customers/update`, `customers/data_request`, `customers/redact`, `shop/redact`, `orders/create`, `orders/updated`, `orders/cancelled`.

The three GDPR endpoints are **mandatory** for App Store approval.

---

## 3. Shopify Integration Model

This is the most important section. The app must respect Shopify's primitives.

| Concept | Where it lives | Our role |
|---|---|---|
| Companies | Shopify (native) | Read/write via Admin GraphQL; never duplicate locally |
| Company Locations | Shopify (native) | Same — Shopify is source of truth |
| Catalogs (price lists) | Shopify (native) | Use up to 3 natively on non-Plus; layer additional tier discounts on top via Shopify Functions |
| Payment terms | Shopify (native) | Read; surface in our UI; do not duplicate |
| Markets | Shopify (native) | Read for tax/locale context |
| Tier discounts beyond 3 catalogs | Our D1 + Function | Stored as `b2b_tiers` rows; applied at cart-transform |
| Wholesale registration applications | Our D1 | Until approved; approval creates a Company in Shopify |
| Dealer asset library | Our R2 + D1 metadata | New capability; no Shopify equivalent |
| Co-op marketing credits (Day 2) | Our D1 → Shopify Store Credit | Issue native Store Credit on approval |
| PO numbers, order notes | Order metafields (Shopify) | Read/write only |
| Saved lists (Day 2) | Our D1 | New capability |

### Plus-mode behaviour

When the shop is on Shopify Plus, the app must detect this and:

- Disable our tier-discount Function (Plus has unlimited catalogs assignable directly to companies).
- Keep all other features active (registration, assets, minimums, shipping rules, sales rep portal, etc.).
- Show a one-time banner in admin explaining what we deactivated and why.

Plus detection: query `shop.plan.shopifyPlus` on install and on every `shop/update` webhook.

---

## 4. Day 1 Feature Requirements (Pilot Build)

Target: shippable to one merchant in production. App Store readiness is Phase 5, not Phase 1.

### 4.1 Gated catalog & price visibility

**Behaviour**

- Public visitors see only products with `b2b_only` metafield = `false` (default). Products with `b2b_only` = `true` are hidden from collections, search results, and direct URLs (404).
- Logged-in buyers whose customer record is linked to an approved Company can see all products, including B2B-only.
- Logged-in buyers see B2B prices on PDP, collection cards, search results, the home page / featured blocks, and cart — wherever a price renders. Site-wide display of the tier delta is controlled by an app-config toggle; see §4.3 "Site-wide price display" and DECISIONS #21.
- Guests and non-B2B logged-in customers see no price and no Add to Cart on `b2b_only` products. On public products, they see public prices normally.
- Recommended store configuration is Online Store → Preferences → Restrict store access → require login (B2B force-login). With it enabled there are no anonymous visitors, which eliminates price-flash risk site-wide and lets the tier price render on first paint.

**Implementation**

- Storefront: Theme App Extension App Embed Block that runs on every page, reads `customer.b2b?` and `customer.companyContactProfiles`, and replaces price/CTA blocks accordingly.
- Server-side filtering: a Search & Discovery metafield filter rule that excludes `b2b_only` items from collections and search; B2B-only products return 404 for non-B2B visitors. No redirect to an alternate collection (per DECISIONS #6).
- Search: register a `collection.products` modification via metaobject; verify it filters correctly on Liquid Search and Search & Discovery app users.
- Caching: cache the customer's company-tier mapping in localStorage with a 5-minute TTL; invalidate on login/logout.

**Acceptance criteria**

- A B2B-only product cannot be reached by guests via direct URL.
- Prices never flash to public users before being hidden (no FOUC).
- Logged-out → logged-in transition reveals B2B prices within 500ms on cached page loads.
- Works on Dawn, Horizon, and at least two paid themes (Impulse, Prestige).

### 4.2 Wholesale registration & approval workflow

**Buyer-facing form**

Hosted at `/apps/b2b-companion/apply` (Shopify App Proxy). Fields:

- Business legal name, trading name
- Business type (select: retailer, distributor, salon, restaurant, etc. — merchant-configurable)
- ABN / EIN / VAT / Tax ID (validated by format per country)
- Business address (Google Places autocomplete)
- Years in business
- Estimated monthly purchase volume (banded select)
- Primary contact name, email, phone
- Two trade references (name, business, email, phone) — optional, configurable
- Document uploads (resale certificate, business licence, etc.) — multi-file, max 10MB each, PDF/JPG/PNG only
- How did you hear about us? (free text)
- Custom questions (up to 5, configured by merchant)

**Form behaviour**

- Progress saved per email address on every field blur — resume from email link.
- Mobile-responsive, accessible (WCAG 2.2 AA).
- Submission triggers async email to applicant ("we'll review within 2 business days") and merchant notification.

**Merchant-facing approval queue**

- Embedded admin route `/applications`
- List view: status filter (pending/approved/rejected/needs-info), search, sort by date.
- Detail view: all submitted data, document previews, internal notes.
- Actions: Approve, Reject (with reason template), Request more info (templated email).
- Approve flow: select tier, set credit limit (optional), select Company Location address (defaults to submitted address), Shopify Company + Location + Contact created via Admin GraphQL, magic-link welcome email sent.

**Acceptance criteria**

- Approval reliably creates a Shopify Company with one Location and one Contact, linked to the buyer's existing or new Customer record.
- Approve / reject actions are idempotent (double-click safe).
- Rejection retains the application for audit; no Shopify-side artefacts created.

### 4.3 Tier-based pricing beyond the 3-catalog limit

**Concept**

Shopify allows 3 active catalogs on non-Plus plans. We let merchants define up to 10 tiers, each with a percentage or fixed-amount discount off the catalog price the buyer would otherwise see.

**Implementation**

- Tier record: `{ id, shop_id, name, discount_type ('percent'|'amount'), discount_value, default_catalog_id (Shopify), priority }`.
- Company-to-tier mapping: `{ shop_id, company_id, tier_id }`. One company has exactly one tier.
- Shopify Function (cart-transform): reads the buyer's company, looks up tier via metafield mirror, applies discount to all eligible line items.
- The Catalog assigned to the buyer's Company Location provides the base price; Markets contributes only currency/locale/tax. Our Function discounts off whatever line price Shopify passes in (per DECISIONS #5).
- Mirror tier mapping to Company metafield `b2b.tier_id` so the Function can read it (Functions cannot query our D1).

**Site-wide price display (controlled in app config)**

Tier pricing must be visible everywhere a price renders — collection cards, search results, the home page / featured-product blocks, related products, the cart drawer, and the PDP — not just the PDP. Native Shopify Catalogs already render the catalog base price site-wide for a buyer in a Company; the gap is our *additional tier delta* (the discount beyond the 3-catalog limit), which the `cart-transform` Function only applies at cart/checkout and so is invisible while browsing. Closing that gap is a display concern, not a pricing-engine concern: the Function remains the source of truth at checkout.

- **One control, whole-site effect.** A single admin toggle (`priceDisplay.siteWide` in `AdminSettings`) is mirrored to Shop metafield `b2b.price_display`. The existing `b2b-price` Theme App Embed reads that metafield and, when enabled, runs on every template instead of only the product template.
- **Overlay, never recompute.** The storefront engine overlays our tier delta *on top of the price Shopify already rendered* (the native catalog price), so it cannot double-discount or drift from the Function. Both percent and fixed-amount tiers are applied client-side against the displayed price: the `cart-transform` Function discounts every line uniformly with no per-product exclusions, so the same per-unit operation on the rendered price is parity-exact with checkout. The overlay only ever reduces a price, and a `MutationObserver` extends it to AJAX-rendered surfaces (cart drawer, quick view, infinite scroll).
- **Plus safety.** Tier resolution is Plus-aware: on Shopify Plus the discount Function is disabled (native catalogs price directly), so `/tier-context` returns no tier and the overlay shows no discount that checkout wouldn't honour. B2B membership still resolves so `b2b_only` gating keeps working. (See DECISIONS #21 for why a server-side `/tier-prices` per-variant map proved unnecessary while discounting stays uniform.)
- **Force-login assumption.** This is designed for stores that enable Online Store → Preferences → Restrict store access → require login (B2B force-login), so there are no anonymous visitors. The overlay is still safe without it (no resolved tier → no-op → public price shows), but force-login is the supported configuration and unlocks an optional zero-FOUC server-side Liquid render mode. The go-live checklist and a one-time admin banner surface this prerequisite.
- **Theme constraint.** Product cards render inside theme section loops, not app-block slots, so per-card Liquid injection isn't possible theme-agnostically. The DOM-scan overlay is the portable path; the merchant-selected price-container preset is extended to card selectors (Dawn/Horizon/custom). See DECISIONS #21.
- **Plus shops:** the overlay no-ops (native catalogs already render site-wide), matching the Function's Plus behaviour.

**Acceptance criteria**

- PDP display matches cart price matches checkout price for every tier on every product. Any mismatch is a P0 bug.
- When site-wide display is on, the tier-discounted price shown on collection cards, search results, home/featured blocks, and the cart drawer matches the PDP and the checkout price for the same variant.
- Function executes under 5ms for carts up to 200 line items.
- Site-wide overlay holds CLS ≤ 0.1 and INP ≤ 200ms on a 50-product collection page (per §10 Built for Shopify benchmarks).
- Disabling a tier removes its discount without losing the tier-to-company mappings (soft delete).
- Plus shops: the tier Function and the site-wide overlay are both disabled, with admin banner.

### 4.4 Dealer asset portal — the wedge

**Concept**

A new section in the customer account area, gated to approved B2B buyers, providing branded marketing materials.

**Asset organisation**

- Folders, sub-folders (max 3 levels deep).
- Per-folder visibility: all B2B / specific tiers / specific companies.
- Asset types: images (JPG/PNG/WEBP), PDFs, videos (MP4/MOV, max 500MB), external links (URL only — for assets hosted on Dropbox, Drive, Frame.io).

**Upload & management (merchant admin)**

- Drag-and-drop upload, multi-file.
- Bulk tag, bulk move, bulk visibility change.
- Asset metadata: title, description, tags, dimensions auto-detected for images.
- Image variants auto-generated on upload: original, web-optimised (1200px wide), thumbnail (300px square). Generated server-side via Workers Image Resizing.

**Buyer experience**

- Accessed via theme app extension App Block placed on a customer account page (`/account/assets`) or via a header link.
- Browse by folder, search by tag or title, filter by asset type.
- Single download or bulk download (zip stream, max 500MB per request).
- Each download logged: `{ shop_id, company_id, customer_id, asset_id, timestamp }`.

**Merchant insights**

- Asset analytics view: downloads per company, top assets, last access timestamps per buyer.

**Storage & delivery**

- R2 bucket per shop (or shared bucket with `shop_id` prefix at smaller scale).
- All access via signed URLs with 24-hour TTL.
- Bandwidth caps per plan: Starter 50GB/month, Growth 250GB/month, Scale 1TB/month (consumer of R2 egress).

**Acceptance criteria**

- 100MB file uploads complete without timeout (chunked upload).
- Buyer downloads always resolve from signed URLs; raw R2 paths never exposed.
- Visibility changes propagate to buyer view in under 30 seconds (cache TTL).

### 4.5 Order minimums and step quantities (per tier)

- Per tier: minimum cart value, minimum units per line, minimum total units per order.
- Per product: case quantity (e.g. sold in 12s), minimum order quantity, maximum order quantity.
- Enforcement via Shopify Function (cart-validation): blocks checkout with clear error message ("Minimum order is 24 units; you have 18").
- PDP surfacing: storefront block displays "Sold in cases of 12 · Minimum 24 units" prominently.

**Acceptance criteria**

- Buyers never reach the checkout success page with a non-compliant cart.
- Error messages are clear, actionable, and tier-aware ("Gold tier minimum: $500").

### 4.6 Per-tier shipping rules

- Free shipping above $X, configurable per tier.
- Flat-rate shipping per tier (overrides store default).
- "Pickup only" option (hides all shipping rates) for specified tiers or specified companies.
- Implementation: Shopify Function (delivery-customization).

**Acceptance criteria**

- Tier-specific rates appear only for that tier; do not leak to retail or other tiers.
- Free shipping threshold respects cart subtotal, excludes tax and discounts.

### 4.7 Admin foundation

- Embedded admin app (Polaris + App Bridge 4).
- Routes: `/onboarding`, `/companies`, `/applications`, `/tiers`, `/assets`, `/settings`, `/analytics` (stub for Day 2).
- Onboarding wizard (see Section 6).
- Settings: brand colours for buyer-facing pages, application form configuration, email templates.

### 4.8 Buyer onboarding flow (see Section 7)

---

## 5. Day 2 Feature Requirements (Post-Pilot, Pre-Marketing-Push)

Built after the pilot is in production and the first 5–10 paying customers are signed up. Order reflects expected demand.

1. **Quick Order Form & CSV upload.** Paste SKUs or upload CSV → cart. UI on `/account/quick-order`.
2. **Saved shopping lists & one-click reorder.** Persistent lists per company, shareable within company users.
3. **Sales rep portal & customer impersonation.** Merchant staff can act as a specified company; orders flow to that company. Audit log of every impersonation session.
4. **PO numbers & order notes per company.** Required-PO toggle per company; appears in checkout, order admin, exported in webhooks.
5. **Quote / RFQ workflow.** "Request quote" replaces "Add to cart" on configured products; merchant responds; quote converts to draft order.
6. **Credit limit enforcement.** Per company, beyond Shopify's payment terms. Open AR (from orders + manual adjustments) tracked; orders above limit blocked at checkout via cart-validation Function.
7. **Catalog import/export.** Bulk CSV management of tier mappings and per-product overrides.
8. **Watermarked asset downloads.** Optional per-asset; embeds dealer company name in image metadata and visible footer.
9. **Co-op marketing credit programme.** Buyers upload advertising proof; merchant approves; native Shopify Store Credit issued.
10. **Multi-user company management.** Buyer admin invites team members, assigns roles (purchaser / approver / AP / read-only).
11. **Order approval workflows within a buying company.** Orders above $X require approver action before placement.
12. **Buyer-side order editing.** Quantity changes, address changes, PO updates on orders not yet fulfilled.

---

## 6. Merchant Onboarding (Shopify Store Owner)

The merchant has likely already configured *some* native B2B since April 2026. The wizard must not assume a blank slate.

### Step 1 — Detect existing state

On install, before showing the wizard:

- Query Companies, Catalogs, Markets, Customer count, B2B-tagged customer count on classic accounts.
- Detect Plus status.
- Detect installed competitor apps (BSS, Wholesale Lock Manager, SparkLayer, Snap) via shop metadata where possible.

Display a summary: "We found 3 companies, 1 catalog, 47 customers tagged 'wholesale'. We'll help you take it from here."

### Step 2 — Migration wizard (classic accounts → Companies)

This is a high-value feature. Many merchants tag classic customer accounts with "wholesale" and have never moved to Companies because the manual work is too painful.

- List all tagged customers.
- Suggest groupings (by tag, by email domain).
- Bulk-create Companies with one Location and one Contact each.
- Preserve order history association (Shopify handles via customer ID).
- Dry-run mode: preview every Company that would be created before committing.

### Step 3 — Tier setup

- Choose tier names (defaults: Distributor, Wholesale, Reseller) or "Use my own".
- Per tier: discount %, optional minimum order value, optional shipping override, optional Markets binding.
- Auto-create matching customer segments for downstream marketing tools.

### Step 4 — Registration form builder

- Toggle required fields, add custom questions, enable/disable document upload.
- Approval mode: manual, auto-approve, threshold-based (e.g. auto-approve EIN-verified applications with referrals).
- Preview as buyer.

### Step 5 — Asset library bootstrap

- Optional: skip and configure later.
- Drag-and-drop initial upload, suggest folder structure (Logos, Product Photography, Lifestyle, PDFs, Videos).
- Set default visibility (all tiers / specific tiers).

### Step 6 — Test customer

- Auto-creates `test-buyer@<shop>.myshopify.test` Company + Contact in test tier.
- Generates magic link the merchant can use to view their store as a B2B buyer.
- Reminder to delete after testing.

### Step 7 — Go live checklist

Visual checklist:

- [ ] At least one tier configured
- [ ] Registration form previewed
- [ ] Application form link added to store navigation or footer (with copyable HTML snippet)
- [ ] At least one test order placed as test buyer
- [ ] Theme app extension activated in published theme
- [ ] First real Company created or imported

---

## 7. Buyer Onboarding (Wholesale Customer)

### Step 1 — Pre-application page

- Public, branded, hosted by merchant via merchant-provided content block (we provide the template).
- Explains programme: who qualifies, what they get, expected response time, basic terms.
- CTA → application form.

### Step 2 — Application form

See Section 4.2 for fields. Behaviour:

- Mobile-friendly, single column, sectioned.
- Progress saved on blur, resumable via email link valid 14 days.
- Document upload with inline preview and remove.
- Visible captcha on submit to prevent bot applications.

### Step 3 — Submission confirmation page + email

- "Application received" page with reference number.
- Email confirms receipt, sets expectation ("we'll review within 2 business days"), gives merchant contact for urgent enquiries.

### Step 4 — Approval email (merchant-templatable)

- Welcome, summary of tier and terms granted.
- Magic link (one-time, expires 7 days) via the Customer Account API → land in `/account` with B2B view active. No password-set step (per DECISIONS #7).
- Link to onboarding guide (optional merchant-supplied PDF or video).

### Step 5 — First login experience

In-app tour, skippable but not annoying:

1. "Here's your wholesale catalog." Highlights pricing badge on PDP.
2. "Here's where you reorder." Points at order history / quick reorder (Day 2 feature; Day 1 just shows order history).
3. "Here's your brand asset library." Direct link.
4. "Add your team." Pre-fills the multi-user invite (Day 2; Day 1 shows a "coming soon" stub).

### Step 6 — Activation nudges

- No first order placed within 14 days → automated email with merchant's account manager contact (configurable) and optional first-order incentive code.
- No login within 30 days → check-in email.
- 60 days inactive → flag in merchant admin for follow-up.

### Step 7 — Self-service company management (Day 1: limited; Day 2: full)

- Day 1: Buyer can view their company profile, see their tier (read-only), see their team members (read-only), see their tax-exempt status.
- Day 2: Buyer admin can invite/remove users, assign roles, update default shipping address, set order approval rules.

---

## 8. Data Model

### D1 schema (key tables)

```sql
CREATE TABLE shops (
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

CREATE TABLE tiers (
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

CREATE TABLE company_tier_mappings (
  shop_id INTEGER NOT NULL,
  shopify_company_id TEXT NOT NULL,
  tier_id INTEGER NOT NULL REFERENCES tiers(id),
  credit_limit REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (shop_id, shopify_company_id)
);

CREATE TABLE applications (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','submitted','approved','rejected','needs_info')),
  form_data_encrypted BLOB NOT NULL,
  submitted_at INTEGER,
  decided_at INTEGER,
  decided_by TEXT,
  decision_notes TEXT,
  created_company_id TEXT,
  created_location_id TEXT
);
CREATE INDEX idx_apps_shop_status ON applications(shop_id, status);
CREATE UNIQUE INDEX idx_apps_pending_email
  ON applications(shop_id, email) WHERE status IN ('draft','submitted','needs_info');

CREATE TABLE assets (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL,
  folder_id INTEGER,
  type TEXT NOT NULL CHECK (type IN ('image','pdf','video','link')),
  title TEXT NOT NULL,
  description TEXT,
  r2_key TEXT,
  external_url TEXT,
  file_size_bytes INTEGER,
  mime_type TEXT,
  visibility_mode TEXT NOT NULL CHECK (visibility_mode IN ('all_b2b','tiers','companies')),
  uploaded_at INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE asset_visibility_rules (
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  rule_type TEXT NOT NULL CHECK (rule_type IN ('tier','company')),
  rule_target_id TEXT NOT NULL,
  PRIMARY KEY (asset_id, rule_type, rule_target_id)
);

CREATE TABLE asset_downloads (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  shopify_company_id TEXT NOT NULL,
  shopify_customer_id TEXT NOT NULL,
  downloaded_at INTEGER NOT NULL,
  ip_hash TEXT NOT NULL
);

CREATE TABLE webhook_log (
  id TEXT PRIMARY KEY,                  -- X-Shopify-Webhook-Id
  shop_id INTEGER NOT NULL,
  topic TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
);
```

### Metafield contracts (Shopify)

| Owner | Namespace.Key | Type | Purpose |
|---|---|---|---|
| Product | `b2b.b2b_only` | boolean | Hide from non-B2B users |
| Product | `b2b.case_quantity` | integer | Step quantity for orders |
| Product | `b2b.min_order_qty` | integer | Per-line minimum |
| Product | `b2b.max_order_qty` | integer | Per-line maximum |
| Company | `b2b.tier_id` | integer | Mirror of our tier mapping for Function access |
| Company | `b2b.credit_limit` | money | Credit ceiling (Day 2 enforcement) |
| Order | `b2b.po_number` | single_line_text | Buyer PO reference (Day 2) |

---

## 9. Security & Compliance

- **OAuth tokens encrypted at rest** with per-shop HKDF-derived AES-GCM keys. Master key in Cloudflare secrets, rotated annually.
- **CSP** on every storefront-rendered page; no inline scripts in storefront block.
- **CSRF protection** on all admin mutations (App Bridge session token verification).
- **Rate limiting:** 100 req/min/shop on admin API, 10 req/min/IP on public application form.
- **GDPR endpoints:** `customers/data_request`, `customers/redact`, `shop/redact` — all three implemented and tested. `customers/redact` must purge from D1 *and* R2.
- **PII inventory:** application form data, applicant uploaded documents, asset download IP hashes. All encrypted at rest.
- **Audit log** for impersonation (Day 2), tier changes, approval decisions, asset visibility changes.
- **Cookie banner not required** (no first-party cookies set on storefront beyond Shopify's own).

---

## 10. Testing Requirements

- **Unit tests:** all pure logic (tier discount math, visibility resolution, minimum validation).
- **Integration tests:** webhook signature verification, GraphQL mutation paths, Function input/output via Shopify's Function testing harness.
- **End-to-end tests** (Playwright):
  - Apply → approve → first login → first order, on Dawn theme.
  - Tier discount appears correctly on PDP, cart, checkout.
  - B2B-only product 404s for guests.
  - Asset download served from signed URL.
- **Theme compatibility:** Dawn, Horizon, Impulse, Prestige minimum. Document any limitations on Vintage themes.
- **Plus-mode parity tests:** every feature exercised on a Plus development store, verifying tier-discount Function is deactivated and direct catalog assignment is respected.
- **Load test:** 200-line cart with 10 tiers, Function execution under 5ms p95.
- **Built for Shopify benchmarks:**
  - App Bridge initialised within 100ms of admin route load
  - Lighthouse Performance ≥ 80 on the buyer-facing pages
  - Web Vitals: LCP ≤ 2.5s, CLS ≤ 0.1, INP ≤ 200ms

---

## 11. Out of Scope (Explicitly)

- Multi-currency conversion beyond what Shopify Markets provides natively.
- Translation of buyer-facing UI beyond merchant's installed languages.
- EDI document exchange (Plus has native; we don't compete).
- ERP integration (Plus has native ACH and EDI; we don't compete).
- POS B2B pricing (not supported by Shopify natively; merchants are aware).
- Headless storefront support in v1. Document a roadmap commitment for v2.
- Classic customer account support beyond the migration wizard. New customers go to Companies.
- Marketplace integration (Amazon, eBay, Faire). Companion apps handle this layer.

---

## 12. Open Questions

These need to be resolved before or during Phase 1. Track in project board.

1. App pricing model and tiers — does the asset portal bandwidth quota become the gating metric?
2. Trial length — 14 or 30 days? Shopify recommends 14 minimum.
3. Single-region vs multi-region R2 — start single-region, decide on multi-region after first 50 customers.
4. Do we need our own application-fraud signal (disposable email detection, geo-velocity checks)?
5. Default email sender — `noreply@<our domain>` with merchant brand, or Shopify Email API for reliability?
6. Pilot merchant payment for the bespoke work — flat fee, hourly, or credit against future SaaS bill?

Resolutions for these (and the ambiguities they raise) are tracked in `DECISIONS.md`.

---

## 13. Revision History

- **v0.2** (2026-05-30) — reconciled with `DECISIONS.md`: §4.3 base price from
  the Company Location's Catalog with Markets contributing only
  currency/locale/tax (#5); §4.1 server-side filtering switched from a
  collection redirect to a Search & Discovery filter with a B2B-only 404 (#6);
  §7 Step 4 buyer auth is Customer Account API magic-link only, no password-set
  flow (#7). Already aligned, left unchanged: §2 webhooks include
  `app/scopes_update`, with `app_subscriptions/update` deferred to Phase 5
  billing (#11).
- **v0.1** (2026-05-18) — initial working draft. Sections 1–12.
