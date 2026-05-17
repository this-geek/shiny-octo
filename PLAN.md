# Implementation Plan — B2B Wholesale Companion

Tracks the work to ship `b2b-app-requirements.md` v0.1. Decisions that shape
the plan live in `DECISIONS.md`. Treat checkboxes as the source of truth for
progress; promote any single phase to GitHub issues/milestones once it
enters active development.

Legend: `P0` blocks the pilot · `P1` blocks Day 2 · `P2` blocks App Store.

---

## Phase 0 — Foundations (target: 1 week)

**Exit criteria:** install → uninstall round-trip works on a dev store;
HMAC-verified webhooks are replay-safe; CI is green on a hello-world Worker.

- [ ] **P0** Confirm pilot merchant facts vs §12 of DECISIONS.md (plan, theme, country, customer counts).
- [ ] **P0** Scaffold monorepo (`apps/worker`, `apps/admin`, `extensions/...`, `packages/shared`) via Shopify CLI.
- [ ] **P0** Configure `shopify.app.toml` with declarative scopes from §2 + `app/scopes_update` (per DECISIONS #11).
- [ ] **P0** Provision Cloudflare resources: Workers, D1, KV (sessions, idempotency, hot cache), R2 bucket, Queues, Cloudflare Images, secrets (master key, Shopify API secret, Resend key).
- [ ] **P0** D1 migration `0001_init.sql` mirroring §8 schema.
- [ ] **P0** Shopify OAuth install flow + token AES-GCM encryption (per-shop HKDF subkey).
- [ ] **P0** Webhook ingress: raw-body HMAC verify, `webhook_log` idempotency, Queue fan-out.
- [ ] **P0** `app/uninstalled` handler (soft-mark `shops.uninstalled_at`, schedule data retention job).
- [ ] **P0** Structured logging helper (no PII, hashed customer IDs only).
- [ ] **P0** CI pipeline: typecheck, unit tests, Shopify Function test harness, Playwright smoke, `gitleaks` secret scan.
- [ ] **P0** `shared` package: pricing logic compiled for both Function (Rust/JS) and storefront block targets, with a parity test scaffold.

---

## Phase 1 — Pilot Day 1 (target: 4–6 weeks)

**Exit criteria:** pilot merchant places a real B2B order on their production
theme, by a real buyer who applied, was approved, saw correct tier pricing,
downloaded an asset, and was warned at a minimum-order violation.

### 1A — Plus detection & shop record
- [ ] **P0** Read `shop.plan.shopifyPlus` on install and `shop/update`; persist `shops.is_plus`.
- [ ] **P0** Admin one-time banner explaining deactivated features when `is_plus = 1`.
- [ ] **P0** All Functions early-return when `is_plus = 1`.

### 1B — §4.1 Gated catalog & price visibility
- [ ] **P0** Define `b2b.b2b_only` product metafield via metafield definitions API.
- [ ] **P0** Theme App Embed Block: Liquid-rendered hide of price/CTA + tier-aware price refinement.
- [ ] **P0** Product template variant that 404s on `b2b.b2b_only == true` when `customer.b2b?` is false (per DECISIONS #6).
- [ ] **P0** Search & Discovery metafield filter recipe documented in admin onboarding.
- [ ] **P0** App Proxy `/tier-context` endpoint returns buyer tier + discount; UX-only cache in localStorage with 5-min TTL (per DECISIONS #10).
- [ ] **P0** Acceptance tests: direct-URL guard, no FOUC, ≤500ms post-login reveal, Dawn + Horizon + Impulse + Prestige.

### 1C — §4.4 Dealer asset portal (the wedge)
- [ ] **P0** R2 layout `shops/<shop_id>/assets/<asset_id>/<variant>` (per DECISIONS #3).
- [ ] **P0** Signed-PUT issuance route; signed-GET (24h TTL) issuance route.
- [ ] **P0** Admin: drag-drop chunked uploader (handles ≥100MB), folder CRUD (3 levels), visibility rules (`all_b2b`/`tiers`/`companies`), bulk move/tag/visibility.
- [ ] **P0** Cloudflare Images variant generation on upload-complete (per DECISIONS #2).
- [ ] **P0** Buyer App Block on `/account/assets`: browse, search, filter, single + zip-stream bulk download.
- [ ] **P0** Server-side visibility resolution on every signed-URL request.
- [ ] **P0** `asset_downloads` logging with hashed IP.
- [ ] **P0** Fair-use 250 GB/shop/month ceiling enforced via KV counter (per DECISIONS #14).
- [ ] **P0** Acceptance tests: 100MB upload, signed-URL-only delivery, ≤30s visibility propagation.

### 1D — §4.3 Tier pricing
- [ ] **P0** `tiers` + `company_tier_mappings` CRUD in admin; soft delete preserves mapping rows.
- [ ] **P0** Mirror `b2b.tier_id` to Company metafield on every mapping change (Queue + retry).
- [ ] **P0** `cart-transform` Function reads Company metafield, applies discount.
- [ ] **P0** PDP storefront refinement reuses `packages/shared` pricing module.
- [ ] **P0** Parity harness: same cart fed to Function + client logic asserts identical totals.
- [ ] **P0** Load test: 200-line cart, 10 tiers, p95 < 5ms.
- [ ] **P0** Plus-mode disable test.

### 1E — §4.2 Wholesale registration & approval
- [ ] **P0** App Proxy form route (path resolved per DECISIONS #9).
- [ ] **P0** Per-blur autosave keyed by email + signed resume token (14-day TTL).
- [ ] **P0** Browser → R2 direct signed PUT for documents (per DECISIONS #8).
- [ ] **P0** AES-GCM encrypt `applications.form_data_encrypted`.
- [ ] **P0** Tax-ID validators (format only): NZ IRD/GST first (pilot). Pluggable per country; ABN, EIN, EU VAT added as merchants need them.
- [ ] **P0** Turnstile captcha on submit.
- [ ] **P0** Admin approval queue (list, filters, detail, doc previews via signed URL).
- [ ] **P0** Idempotent approve: D1 tx + GraphQL `companyCreate` / `companyLocationCreate` / `companyContactCreate` with mutation idempotency key.
- [ ] **P0** Reject + Request-more-info templated emails (Resend, per DECISIONS #16).
- [ ] **P0** Magic-link welcome via Customer Account API (per DECISIONS #7).
- [ ] **P0** Acceptance tests: idempotency under double-click, reject creates no Shopify artefacts.

### 1F — §4.5 Minimums & step quantities
- [ ] **P0** Product metafields `b2b.case_quantity`, `b2b.min_order_qty`, `b2b.max_order_qty` definitions.
- [ ] **P0** Tier-level minimums via existing `tiers.min_order_value` / `min_order_units`.
- [ ] **P0** `cart-validation` Function with localised messages (`read_locales`).
- [ ] **P0** Storefront block surfaces case qty / minimum on PDP.

### 1G — §4.6 Per-tier shipping
- [ ] **P0** `delivery-customization` Function for free-shipping threshold, flat rate, pickup-only.
- [ ] **P0** Acceptance test: rates don't leak across tiers; threshold excludes tax + discount.

### 1H — §4.7 Admin foundation
- [ ] **P0** Routes: `/onboarding`, `/companies`, `/applications`, `/tiers`, `/assets`, `/settings`, `/analytics` (stub).
- [ ] **P0** Settings: brand colours, application form builder, email templates.

### 1I — §6 Merchant onboarding wizard
- [ ] **P0** Step 1 detect existing Companies/Catalogs/Markets + classic wholesale-tagged customers.
- [ ] **P1** Step 2 migration wizard (dry-run + commit). Downgraded to P1 per DECISIONS #12 — ~20 wholesale-tagged customers can be imported manually for the pilot.
- [ ] **P0** Step 3 tier setup with defaults + Markets binding.
- [ ] **P0** Step 4 registration form builder + approval mode.
- [ ] **P0** Step 5 asset library bootstrap (skippable).
- [ ] **P0** Step 6 test customer creation (email per DECISIONS #15) + magic link.
- [ ] **P0** Step 7 go-live checklist.

### 1J — §7 Buyer onboarding
- [ ] **P0** Pre-application content block template (merchant-installable).
- [ ] **P0** Submission confirmation page + email (reference number).
- [ ] **P0** Approval email + magic link (7-day TTL).
- [ ] **P0** First-login tour (Day-1 stubs for Day-2 features).
- [ ] **P0** Activation nudges (14/30/60 day) via Workers Cron Triggers + Resend.
- [ ] **P0** Day-1 company profile view (read-only tier, team, tax-exempt status).

---

## Phase 2 — Hardening & GDPR (target: 1–2 weeks)

**Exit criteria:** all GDPR endpoints pass Shopify's automated checks;
Lighthouse Performance ≥ 80 on buyer pages; App Bridge init < 100ms.

- [ ] **P2** `customers/data_request` handler returns the buyer's data within 30 days.
- [ ] **P2** `customers/redact` purges D1 rows + R2 documents tied to the customer.
- [ ] **P2** `shop/redact` purges everything after 48h grace.
- [ ] **P2** Per-shop rate limiter via KV (100 req/min admin, 10 req/min/IP public).
- [ ] **P2** CSP headers on every storefront-rendered page; no inline scripts.
- [ ] **P2** Audit-log table + writes for approvals, tier changes, asset visibility changes.
- [ ] **P2** PII inventory + scope-justification doc (for BFS review).
- [ ] **P2** Web Vitals + App Bridge perf measured in CI synthetic run.

---

## Phase 3 — Day 2 features (each behind a feature flag, sequenced per DECISIONS #13)

- [ ] **P1** Quick Order Form & CSV upload (`/account/quick-order`).
- [ ] **P1** Sales rep portal & customer impersonation (+ audit log).
- [ ] **P1** PO numbers & order notes per company (required-PO toggle).
- [ ] **P1** Saved shopping lists & one-click reorder.
- [ ] **P1** Credit limit enforcement via `cart-validation` Function + open-AR tracker.
- [ ] **P1** Quote / RFQ workflow → draft order.
- [ ] **P1** Multi-user company management (roles).
- [ ] **P1** Order approval workflows within a company.
- [ ] **P1** Buyer-side order editing (pre-fulfilment).
- [ ] **P1** Watermarked asset downloads.
- [ ] **P1** Co-op marketing credit programme → Shopify Store Credit.
- [ ] **P1** Catalog import/export (tier mappings + product overrides).
- [ ] **P1** Application fraud signal (DECISIONS #16 Q4).

---

## Phase 4 — Theme & Plus parity (rolling, must finish before Phase 5)

- [ ] **P2** Playwright matrix: Dawn, Horizon, Impulse, Prestige.
- [ ] **P2** Document Vintage-theme limitations.
- [ ] **P2** Plus dev store: every feature exercised; tier Function confirmed off; direct catalog assignment honoured.

---

## Phase 5 — App Store submission

- [ ] **P2** Public pricing plans wired to Shopify Billing (bandwidth as gating metric, DECISIONS #16 Q1).
- [ ] **P2** 14-day trial flow.
- [ ] **P2** Listing copy + screenshots + demo store.
- [ ] **P2** Scope justification doc final.
- [ ] **P2** Built-for-Shopify checklist sign-off.
- [ ] **P2** Support docs + status page.

---

## Cross-cutting backlog

- [ ] **P0** Requirements doc patches — apply DECISIONS #5, #6, #7, #11 to `b2b-app-requirements.md`, bump to v0.2.
- [ ] **P0** Test data fixtures: dev store seed (companies, tiers, assets, applications) checked into `apps/admin/fixtures`.
- [ ] **P2** Runbook: webhook backfill, R2 redaction, key rotation.
- [ ] **P2** Cost dashboard: D1 reads, R2 egress, Images transformations, Workers requests per shop.
