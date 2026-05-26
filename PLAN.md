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

- [x] **P0** Confirm pilot merchant facts vs §12 of DECISIONS.md (plan, theme, country, customer counts). *(Confirmed 2026-05-23: NZ, Advanced, Dawn, ~20 wholesale customers.)*
- [x] **P0** Scaffold monorepo (`apps/worker`, `apps/admin`, `extensions/...`, `packages/shared`) via Shopify CLI.
- [x] **P0** Configure `shopify.app.toml` with declarative scopes from §2 + `app/scopes_update` (per DECISIONS #11).
- [ ] **P0** Provision Cloudflare resources: Workers, D1, KV (sessions, idempotency, hot cache), R2 bucket, Queues, Cloudflare Images, secrets (master key, Shopify API secret, Resend key). *(See MANUAL_STEPS.md)*
- [x] **P0** D1 migration `0001_init.sql` mirroring §8 schema.
- [x] **P0** Shopify OAuth install flow + token AES-GCM encryption (per-shop HKDF subkey).
- [x] **P0** Webhook ingress: raw-body HMAC verify, `webhook_log` idempotency, Queue fan-out.
- [x] **P0** `app/uninstalled` handler (soft-mark `shops.uninstalled_at`, schedule data retention job).
- [x] **P0** Structured logging helper (no PII, hashed customer IDs only).
- [x] **P0** CI pipeline: typecheck, unit tests, Shopify Function test harness, Playwright smoke, `gitleaks` secret scan.
- [x] **P0** `shared` package: pricing logic compiled for both Function (Rust/JS) and storefront block targets, with a parity test scaffold.

---

## Phase 1 — Pilot Day 1 (target: 4–6 weeks)

**Exit criteria:** pilot merchant places a real B2B order on their production
theme, by a real buyer who applied, was approved, saw correct tier pricing,
downloaded an asset, and was warned at a minimum-order violation.

### 1A — Plus detection & shop record
- [x] **P0** Read `shop.plan.shopifyPlus` on install and `shop/update`; persist `shops.is_plus`.
- [x] **P0** Admin one-time banner explaining deactivated features when `is_plus = 1`.
- [x] **P0** All Functions early-return when `is_plus = 1`.

### 1B — §4.1 Gated catalog & price visibility
- [x] **P0** Define `b2b.b2b_only` product metafield via metafield definitions API.
- [x] **P0** Theme App Embed Block: Liquid-rendered hide of price/CTA + tier-aware price refinement. *(Body-target App Embed in `extensions/theme-app-extension/blocks/b2b-price.liquid` with a non-PDP guard so it no-ops on other templates. Configured via the theme editor's App embeds panel; was previously a section-target block (i.e. invisible in the App embeds panel) — `shopify.extension.toml` added alongside.)*
- [x] **P0** Product template variant that 404s on `b2b.b2b_only == true` when `customer.b2b?` is false (per DECISIONS #6).
- [x] **P0** Search & Discovery metafield filter recipe documented in admin onboarding.
- [x] **P0** App Proxy `/tier-context` endpoint returns buyer tier + discount; UX-only cache in localStorage with 5-min TTL (per DECISIONS #10).
- [x] **P0** Acceptance tests: direct-URL guard, no FOUC, ≤500ms post-login reveal, Dawn + Horizon + Impulse + Prestige. *(Hermetic Playwright suite in `e2e/` — captured PDP fixtures per theme, `/tier-context` mocked via `page.route()`. Covers: redirect on b2b_only + non-B2B (`direct-url-guard.spec.ts`), cache-hit reveal completes before DOMContentLoaded (`no-fouc.spec.ts`), p95 cold-cache reveal < 500ms over 10 iterations with 50ms mocked network (`reveal-latency.spec.ts`), hide-rule selectors present per theme (`theme-matrix.spec.ts`). Asset lockstep via `e2e/scripts/sync-asset.mjs` mirrors the Phase 1D parity-test convention. Live-store smoke is the existing `MANUAL_STEPS.md §10.5` pre-pilot checklist.)*

### 1C — §4.4 Dealer asset portal (the wedge)
- [x] **P0** R2 layout `shops/<shop_id>/assets/<asset_id>/<variant>` (per DECISIONS #3). *(`apps/worker/src/lib/r2-keys.ts` — key conventions + cross-tenant guard.)*
- [x] **P0** Signed-PUT issuance route; signed-GET (24h TTL) issuance route. *(Implemented via R2 binding rather than S3-SigV4: admin uploads route through the Worker as multipart via `/admin/assets/uploads/*` and stream straight into R2; buyer downloads stream out of the Worker at `/proxy/assets/download/:id`. Same net effect — R2 stays fully private, no public URLs — without needing R2 access-key secrets.)*
- [x] **P0** Admin: chunked uploader (handles ≥100MB), folder CRUD (3 levels), visibility rules (`all_b2b`/`tiers`/`companies`), bulk move/visibility/delete. *(File-picker chunked uploader in `apps/admin/app/routes/assets.tsx`; folder CRUD enforces 3-level depth in `lib/folder-store.ts`; bulk endpoints `/admin/assets/bulk-{move,visibility,delete}`. Drag-drop UI and bulk tag deferred — no `tags` column yet.)*
- [ ] **P0** Cloudflare Images variant generation on upload-complete (per DECISIONS #2). *(Deferred — needs Images API token + a queue handler to fan out variants once the canonical R2 key is in place. Buyer view currently serves the `original` variant for images.)*
- [x] **P0** Buyer App Block on customer account page: browse, search, filter, single download. *(Re-platformed in Phase 1H+ as a Customer Account UI extension — `extensions/customer-account-asset-portal/` (full-page Preact + web-components extension targeting `customer-account.page.render` only — Shopify's validator forbids combining the page target with any other, so the order-index link teaser is deferred to a sibling extension). Auth is the Customer Account session token (`middleware/customer-account-token.ts`); the Worker route `/customer-account/assets/*` reuses the same `lib/asset-serve.ts` helpers as the legacy App Proxy path, so visibility + bandwidth rules can't drift. The old `theme-app-extension/blocks/b2b-assets.liquid` was removed because Customer Account pages don't render theme app blocks. Zip-stream bulk download deferred — needs a streaming-zip implementation in the Worker; tracked for follow-up.)*
- [x] **P0** Worker-hosted dealer portal via App Proxy (replaces the `customer-account.page.render` extension, which kept tripping Shopify's "cannot combine targets" validator). *(`apps/worker/src/routes/portal.ts` — entry handler at `/proxy/portal`, JSON API subroutes at `/proxy/portal/api/*`, and a vanilla-JS SPA bundle served from `/proxy/portal/static/app.{js,css}` (string-exported from `routes/portal-assets/` to skip a build step). Shell page links the external assets, embeds boot JSON with `proxy_base` derived from Shopify's `path_prefix` query so URLs work across merchant proxy subpaths. CSP `script-src 'self'; style-src 'self'`. All routes mounted under `appProxyRouter` so every hit — entry, API, and static — is HMAC-verified by Shopify. API routes reuse `lib/asset-serve.ts`, `lib/company-profile.ts`, `lib/tour-state.ts` unchanged. The customer-account extension was reduced to a single-target link block (`customer-account.order-index.block.render`) in `extensions/customer-account-asset-portal/src/PortalLinkBlock.tsx` — it just surfaces a "Open dealer portal" card on the buyer's order index that links to the proxy URL. Removed: `apps/worker/src/routes/customer-account.ts`, `middleware/customer-account-token.ts` (+ test), and the old `AssetPortalPage.tsx`/`CompanyProfileView.tsx`/`TourBanner.tsx`/`api.ts` from the extension.)*
- [x] **P0** Server-side visibility resolution on every signed-URL request. *(`lib/asset-visibility.ts` re-resolves tier/company → asset visibility on every list and every download; client never sees `r2_key` for hidden assets.)*
- [x] **P0** `asset_downloads` logging with hashed IP. *(`lib/asset-store.ts::logAssetDownload`; called from `routes/app-proxy.ts` with SHA-256 hashed customer + IP. IP is read from `CF-Connecting-IP` when present, otherwise falls back to a per-customer hash so the NOT-NULL column is always populated.)*
- [x] **P0** Fair-use 250 GB/shop/month ceiling enforced via KV counter (per DECISIONS #14). *(`lib/bandwidth-counter.ts` — KV key `bw:<shop_id>:<YYYY-MM>`; buyer download route 429s when the bucket is at cap.)*
- [ ] **P0** Acceptance tests: 100MB upload, signed-URL-only delivery, ≤30s visibility propagation. *(Deferred — Playwright + a real R2 + admin session. Server-side visibility is covered by unit tests in `asset-visibility.test.ts`; upload/download round-trip needs a deployed environment.)*

### 1D — §4.3 Tier pricing
- [x] **P0** `tiers` + `company_tier_mappings` CRUD in admin; soft delete preserves mapping rows. *(D1 stores in `apps/worker/src/lib/tier-store.ts` + `company-mapping-store.ts`; admin endpoints in `routes/admin-tiers.ts`; UI in `apps/admin/app/routes/tiers.tsx`.)*
- [x] **P0** Mirror `b2b.tier_id` to Company metafield on every mapping change (Queue + retry). *(Inline enqueue of `_internal/mirror-company-tier` messages on every mapping CRUD; handler `mirror-company-tier.ts` writes via `setMetafields`; queue's native retry semantics drive backoff.)*
- [x] **P0** `cart-transform` Function reads Company metafield, applies discount. *(Function reads `b2b.tier_id` Company metafield + `b2b.tiers_config` Shop metafield, emits per-line `fixedPricePerUnit` overrides.)*
- [x] **P0** PDP storefront refinement reuses `packages/shared` pricing module. *(Already shipped in Phase 1B; Function uses the same `applyTierDiscount`.)*
- [x] **P0** Parity harness: same cart fed to Function + client logic asserts identical totals. *(`extensions/functions/cart-transform/src/index.test.ts` asserts cart-transform aggregated total equals `calcCartDiscount` total for the strict identity case.)*
- [ ] **P0** Load test: 200-line cart, 10 tiers, p95 < 5ms. *(Deferred — needs the Shopify Function test harness. Pure-function logic is exercised by the parity test which runs in microseconds.)*
- [x] **P0** Plus-mode disable test. *(Tested in each of the three Function test suites.)*

### 1E — §4.2 Wholesale registration & approval
- [x] **P0** App Proxy form route (path resolved per DECISIONS #9). *(`apps/worker/src/routes/app-proxy-applications.ts` — form-config, autosave, resume, submit, doc-upload, all under `/application/*`. Mounted under `appProxyRouter` so the App Proxy HMAC middleware runs first. Storefront block in `theme-app-extension/blocks/b2b-application.liquid` is a body-target App Embed with a configurable `apply_path` setting; renders only on the merchant's chosen page path.)*
- [x] **P0** Per-blur autosave keyed by email + signed resume token (14-day TTL). *(`lib/resume-token.ts` — stateless HMAC-SHA256 over `{aid,email,exp}` with a per-shop HKDF-derived secret; storefront JS in `extensions/theme-app-extension/assets/b2b-application.js` saves on field `blur` with a 600ms debounce.)*
- [x] **P0** Browser → R2 direct signed PUT for documents (per DECISIONS #8). *(Implemented via the same Worker-streamed multipart pattern as the Phase 1C asset uploader — `/application/document-upload`, `…/parts/:n`, `…/complete`. R2 stays fully private; no public PUT URLs are minted. Same trade-off as 1C.)*
- [x] **P0** AES-GCM encrypt `applications.form_data_encrypted`. *(`lib/application-store.ts::encryptForm` uses the existing per-shop HKDF subkey from `lib/crypto.ts`; the encrypted blob holds custom fields + PII + uploaded document references.)*
- [x] **P0** Tax-ID validators (format only): NZ IRD/GST first (pilot). Pluggable per country; ABN, EIN, EU VAT added as merchants need them. *(`lib/tax-id-validators.ts` — NZ IRD checksum (both weight tables); unknown countries pass through so we don't reject good applications from unwired jurisdictions.)*
- [x] **P0** Turnstile captcha on submit. *(`lib/turnstile.ts` — Cloudflare siteverify; gated on `TURNSTILE_SECRET_KEY` / `TURNSTILE_SITE_KEY` env vars and exposed to the storefront via `/application/form-config`. Skipped with a warn log when not configured.)*
- [x] **P0** Admin approval queue (list, filters, detail, doc previews via signed URL). *(`routes/admin-applications.ts` + `apps/admin/app/routes/applications.tsx`. Documents stream through the Worker — `/admin/applications/:id/document?key=` — re-checking shop ownership + document allowlist on every fetch.)*
- [x] **P0** Idempotent approve: D1 tx + GraphQL `companyCreate` / `companyLocationCreate` / `companyContactCreate` with mutation idempotency key. *(`lib/shopify-companies-create.ts` sends `X-Idempotency-Key: b2b-companion:approve:<shop>:app-<id>`; the route also short-circuits before re-hitting Shopify if `applications.created_company_id` is already populated.)*
- [x] **P0** Reject + Request-more-info templated emails (Resend, per DECISIONS #16). *(`lib/email-resend.ts` + `handlers/send-application-email.ts`; templates read from `shops.settings_json.emailTemplates` with safe defaults. Variables HTML-escaped to prevent template-injection.)*
- [x] **P0** Magic-link welcome via Customer Account API (per DECISIONS #7). *(`lib/shopify-customer-invite.ts::sendCustomerInvite` wraps the `customerSendAccountInviteEmail` mutation. Approve flow in `routes/admin-applications.ts` calls it best-effort after `companyCreate` succeeds — failure logs but doesn't block approval, since the merchant can resend from the application detail page. Same helper is used by the Phase 1I onboarding wizard's Step 6 test buyer.)*
- [x] **P0** Acceptance tests: idempotency under double-click, reject creates no Shopify artefacts. *(`routes/admin-applications.test.ts` — "double-click approve does not create a second Company" and "on companyCreate failure, the application stays in submitted and no row mutates" cover both invariants.)*

### 1F — §4.5 Minimums & step quantities
- [x] **P0** Product metafields `b2b.case_quantity`, `b2b.min_order_qty`, `b2b.max_order_qty` definitions. *(Already in `B2B_METAFIELD_DEFINITIONS` from Phase 0; ensured on every install.)*
- [x] **P0** Tier-level minimums via existing `tiers.min_order_value` / `min_order_units`. *(Surfaced in the tiers admin UI; cart-validation Function enforces them.)*
- [x] **P0** `cart-validation` Function with localised messages (`read_locales`). *(Function implemented; messages currently English-only — `read_locales` wiring deferred.)*
- [x] **P0** Storefront block surfaces case qty / minimum on PDP. *(`extensions/theme-app-extension/blocks/b2b-minimums.liquid` — body-target App Embed that reads `b2b.case_quantity` / `b2b.min_order_qty` / `b2b.max_order_qty` and renders a notice on PDP for B2B customers only. Companion `assets/b2b-minimums.js` snaps the standard `form[action*="/cart/add"] input[name="quantity"]` to the next valid value on blur — case-multiple, clamped to min/max — as a UX nudge ahead of the cart-validation Function which still enforces server-side. No-ops on non-product templates and on products without any of the three metafields, so it's safe to leave enabled globally. Snap logic covered by `assets/b2b-minimums.test.js` mirroring the b2b-price parity-test pattern.)*

### 1G — §4.6 Per-tier shipping
- [x] **P0** `delivery-customization` Function for free-shipping threshold, flat rate, pickup-only. *(Implemented; note that the Shopify delivery-customization API only supports `hide`/`rename`, so the price changes are advertised via rename — actual rate adjustment needs a paired delivery-discount Function or shipping-zone config.)*
- [x] **P0** Acceptance test: rates don't leak across tiers; threshold excludes tax + discount. *(Covered by tests in `delivery-customization/src/index.test.ts`.)*

### 1H — §4.7 Admin foundation
- [x] **P0** Routes: `/onboarding`, `/companies`, `/applications`, `/tiers`, `/assets`, `/settings`, `/analytics` (stub). *(Stub Polaris empty states with App Bridge `<ui-nav-menu>` wired in `root.tsx`.)*
- [x] **P0** Settings: brand colours, application form builder, email templates. *(Stored in `shops.settings_json` via `GET/PUT /admin/settings`; shallow-merges with unrelated blob keys to preserve `app_proxy.subpath` per DECISIONS #9.)*

### 1I — §6 Merchant onboarding wizard
- [x] **P0** Step 1 detect existing Companies/Catalogs/Markets + classic wholesale-tagged customers. *(`lib/shopify-detect.ts` runs `companies`/`catalogs`/`markets`/`customers(query:"tag:wholesale")` in one GraphQL roundtrip; `routes/admin-onboarding.ts::POST /admin/onboarding/detect` persists counts into the step's `data` blob. Catalogs query degrades gracefully on older API versions — UI shows "unknown".)*
- [ ] **P1** Step 2 migration wizard (dry-run + commit). Downgraded to P1 per DECISIONS #12 — ~20 wholesale-tagged customers can be imported manually for the pilot. *(Intentionally omitted from the 1I wizard; the six implemented steps skip past it.)*
- [x] **P0** Step 3 tier setup with defaults + Markets binding. *(Wizard step routes the merchant to the existing `/tiers` admin page and marks itself complete on confirmation. Tiers UI was already live in Phase 1D.)*
- [x] **P0** Step 4 registration form builder + approval mode. *(Wizard step routes to `/settings` where the form builder + email templates live; mark-complete button records progress.)*
- [x] **P0** Step 5 asset library bootstrap (skippable). *(Wizard step routes to `/assets`; explicit Skip button flagged via `SKIPPABLE_STEPS` in `lib/onboarding-store.ts`.)*
- [x] **P0** Step 6 test customer creation (email per DECISIONS #15) + magic link. *(`POST /admin/onboarding/test-buyer/create` calls `createCompanyForApplication` with email `test-buyer+<shop>@<EMAIL_FROM-domain>` (catch-all per DECISIONS #15), then `sendCustomerInvite` (`customerSendAccountInviteEmail` mutation) for the magic link. Idempotent on Shopify's side via the existing `X-Idempotency-Key` plumbing. Resend endpoint at `POST /admin/onboarding/test-buyer/:cid/invite`.)*
- [x] **P0** Step 7 go-live checklist. *(Static checklist surfacing the three storefront-enable steps merchants must take in the theme editor + Customer Account UI panel before announcing the portal.)*

State persists in `shops.settings_json.onboarding` (lib/onboarding-store.ts). Status lifecycle is pending → completed | dismissed; admin home surfaces a continue-setup banner whenever status is pending. Backed by 11 new unit tests covering state transitions + the magic-link mutation.

### 1J — §7 Buyer onboarding
- [x] **P0** Pre-application content block template (merchant-installable). *(`extensions/theme-app-extension/blocks/b2b-preapplication.liquid` — body-target App Embed with a configurable `landing_path`; merchant edits heading / subheading / bullet list / CTA label + path / footnote from the theme editor. Pure Liquid, no JS, so it renders fast and works without the App Proxy. CTA defaults point at the `b2b-application` block's default `apply_path`.)*
- [x] **P0** Submission confirmation page + email (reference number). *(Confirmation card with the `B2B-<shop>-<id>` reference was wired in 1E — see `b2b-application.js::onSubmit` and the `submitted` email template in `handlers/send-application-email.ts`. Phase 1J adds the `accountUrl` template var (`https://<shop>/account`) and a working `resumeUrl` for the `needs_info` template, derived from the merchant's `apply_path` plus a fresh 14-day resume token.)*
- [x] **P0** Approval email + magic link (7-day TTL). *(Magic-link email is `customerSendAccountInviteEmail` (Shopify default 7-day TTL) — wired in 1I. Phase 1J's `approved` template now references the merchant-side `{{accountUrl}}` so the buyer has a deep link into the customer-account portal once they've signed in. Merchants can still customise via `shops.settings_json.emailTemplates.approved`.)*
- [x] **P0** First-login tour (Day-1 stubs for Day-2 features). *(KV-backed dismissal in `lib/tour-state.ts` (key `tour:<shop_id>:<sha256(customer_gid)>`, 180-day TTL). New Worker routes `GET /customer-account/tour-status` + `POST /customer-account/tour-dismiss`. UI in `extensions/customer-account-asset-portal/src/TourBanner.tsx` — lists Day-1 features and three Day-2 teasers per DECISIONS #13 ordering (Quick Order, Saved Lists, Quotes).)*
- [x] **P0** Activation nudges (14/30/60 day) via Workers Cron Triggers + Resend. *(Daily cron `0 9 * * *` in `wrangler.toml` fires `scheduled` → `runActivationNudgesScan` (`handlers/activation-nudges.ts`). For each approved application within the 14-70 day window, the handler picks the nudge milestone, checks `application_nudges` (new table in `migrations/0004_phase1j_nudges.sql`) for prior sends, then probes Shopify orders via `lib/shopify-orders.ts` and skips active buyers. Enqueues through the existing `_internal/send-application-email` queue with three new templates (`nudge_14d/30d/60d`).)*
- [x] **P0** Day-1 company profile view (read-only tier, team, tax-exempt status). *(`lib/company-profile.ts` assembles tier (from D1) + company contacts + locations + per-location tax-exempt flag (via Admin GraphQL). New route `GET /customer-account/profile`. UI in `extensions/customer-account-asset-portal/src/CompanyProfileView.tsx`, accessible via a tab on the existing customer-account asset portal page so we keep a single `customer-account.page.render` target.)*

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
- [ ] **P0** Internal operator console at `/_ops/*` behind Cloudflare Access SSO (per DECISIONS #17): webhook replay, queue retry, per-shop feature flags, GDPR audit view, encryption-key rotation. Operator identity captured in audit log on every mutation. Promoted to P0 because the pilot phase is when we most need it; UI can stay minimal.

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
