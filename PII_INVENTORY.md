# PII Inventory & Scope Justification — B2B Companion

Companion document for Phase 2 review (Built-for-Shopify, GDPR, and the
pilot merchant's privacy-impact review). Whenever a column, KV key, or
R2 prefix is added that holds personal data, update the relevant table
below in the same commit.

Last reviewed: 2026-05-30.

---

## 1. Personal data we store

Personal data is anything that identifies, or could re-identify, a
buyer or a merchant staff user. The third column gives the **retention
trigger** — when we delete or anonymise it.

### 1.1 In D1

| Table.column | Holds | Encryption | Retention trigger |
|---|---|---|---|
| `shops.access_token_encrypted` | Shopify Admin API access token, AES-GCM at rest (per-shop HKDF subkey of `MASTER_KEY`) | AES-GCM | Deleted on `app/uninstalled` after the 30-day stand-down (`shop_redact` / `app_uninstall_purge` sweep — `lib/gdpr-purge.ts::redactShop`). |
| `shops.shopify_domain` | The merchant's myshopify.com domain | None (operational identifier) | Same as above. |
| `shops.settings_json` | Brand colours, email templates, application-form field config, feature flags, **operator-set per-shop config** (`featureFlags`). May echo merchant-staff email if they put one in an email template. | None | Same as above. |
| `applications.email` | Applicant's email address | None (used for resume-link signature lookup, deduping by `(shop_id, email)`) | Deleted on `customer_redact` for that customer; full purge on `shop_redact`. |
| `applications.form_data_encrypted` | Custom application fields, applicant name, business name, tax ID, free-text notes, R2 references to uploaded documents | AES-GCM (per-shop HKDF subkey) | Same as above. |
| `applications.decided_by` / `decision_notes` | Shopify staff user GID + free-text notes | None | Retained while the row exists; not considered buyer PII (it's merchant-staff identity, which the merchant already controls). |
| `applications.created_company_id` / `created_location_id` / `shopify_customer_id` | Shopify GIDs after approval | None | Hard-deleted on `customer_redact` for the matching customer; full purge on `shop_redact`. |
| `application_nudges` (`application_id` + nudge kind) | No PII directly, but joins back to `applications`. | None | Hard-deleted alongside `applications` on `customer_redact`. |
| `asset_downloads.shopify_company_id` | Shopify Company GID | None | Hard-deleted on `customer_redact` or `shop_redact`. |
| `asset_downloads.shopify_customer_id` | **SHA-256 hash** of the customer GID | n/a — hash | Same as above. |
| `asset_downloads.ip_hash` | SHA-256 hash of `CF-Connecting-IP`, salted per-customer | n/a — hash | Same as above. |
| `webhook_log` | Topic + `X-Shopify-Webhook-Id`. No bodies, no PII. | None | Retained 90 days for ops debugging (no automated TTL yet — tracked in PLAN cross-cutting backlog). |
| `audit_log.actor` | Shopify staff user GID (merchant-side action audit) | None | Retained for the life of the shop install; purged on `shop_redact`. |
| `ops_log.operator_email` | App-vendor SSO email (Cloudflare Access identity) | None | Vendor-internal; retained indefinitely. Distinct from buyer PII — these are our own staff. |
| `gdpr_requests.payload_json` | Original webhook body (may include customer email/ID) | None | Retained 30 days post-completion for compliance proof; cron should hard-delete after that (TODO). |
| `tiers` / `company_tier_mappings` | Merchant configuration; references Company GIDs. No buyer PII. | None | Purged on `shop_redact`. |

### 1.2 In KV

| Namespace + key | Holds | Retention |
|---|---|---|
| `KV_SESSIONS:<sid>` | Buyer session metadata (resolved tier, B2B membership) | TTL: 5 min per `/tier-context` cache decision (DECISIONS #10). |
| `KV_IDEMPOTENCY:webhook:<id>` | Idempotency marker (no body) | TTL: 48h. |
| `KV_IDEMPOTENCY:upload:<session>` | R2 multipart session state (key, upload_id, filename, mime, total bytes — no PII) | TTL: 24h. |
| `KV_HOT_CACHE:tier:<shop_id>:<customer_hash>` | Resolved buyer tier id | TTL: 5 min. Deleted on `customer_redact`. |
| `KV_HOT_CACHE:bw:<shop_id>:<YYYY-MM>` | Bandwidth counter for the fair-use cap (no PII) | TTL: end of month + 30 days. |
| `KV_HOT_CACHE:rl:<bucket>:<id>:<min_epoch>` | Rate-limit counter; for `public` bucket `<id>` is the client IP (raw, not hashed) | TTL: 90s. Sub-PII — the IP is only retained for the duration of one minute's rate-limit window. |
| `KV_HOT_CACHE:cf_access:jwks` | Cloudflare Access JWKS (no PII) | TTL: 10 min. |

> **Open item**: the rate-limit `public` bucket stores raw IP for ≤90s. This is the only place we hold a raw IP at rest. If a privacy review demands it, swap to a hashed IP — costs nothing functionally because the IP is only ever compared as an equality key.

### 1.3 In R2

| Prefix | Holds | Retention |
|---|---|---|
| `shops/<shop_id>/assets/<asset_id>/<variant>` | Merchant-uploaded files for the dealer asset portal | Soft-delete on the D1 row leaves the object in place for the 30-day recovery window (no cron yet — tracked in PLAN). Purged on `shop_redact`. |
| `shops/<shop_id>/applications/<application_id>/<filename>` | Documents uploaded by applicants (W-9, tax certificate, resale licence, etc.) | Deleted on `customer_redact` (the prefix is removed by `lib/gdpr-purge.ts::redactCustomer`). |
| `shops/<shop_id>/uploads/<session>/<filename>` | Multipart-upload staging area | Deleted on `/complete` (server-side copy + delete) or on `/abort`. |

### 1.4 In logs

Per the working norms in `CLAUDE.md`, logs never contain PII. The
canonical logger (`lib/logger.ts`) hashes customer IDs and accepts only
hash inputs for any field that could be a customer identifier. Shop
domains are operational identifiers and are logged unredacted (a
merchant has the right to know we're processing their data).

---

## 2. Scope justification

For every Shopify access scope we declare in `shopify.app.toml`,
document why the app needs it. This is the section the Built-for-Shopify
review will quote back at us — keep it tight.

| Scope | Why we need it | Where it's used |
|---|---|---|
| `read_companies` / `write_companies` | Read existing Companies to surface them in the tier-mapping admin; create Companies + locations + contacts when an application is approved (DECISIONS #7). Mirror `b2b.tier_id` Company metafield on every mapping change. | `lib/shopify-companies.ts`, `lib/shopify-companies-create.ts`, `handlers/mirror-company-tier.ts` |
| `read_customers` / `write_customers` | Send the magic-link welcome email after approval (`customerSendAccountInviteEmail`). Resolve `customer.b2b?` membership server-side. Read customer email for activation-nudge probes. | `lib/shopify-customer-invite.ts`, `lib/buyer-context.ts`, `handlers/activation-nudges.ts` |
| `read_files` / `write_files` | Reserved for asset-library v2 (Shopify Files mirror of public assets). Not exercised in v1; remove if not needed by App Store submission. | — |
| `read_locales` | `cart-validation` Function uses `read_locales` to localise minimum-violation messages. | `extensions/functions/cart-validation` |
| `read_markets` | Surface Markets in the tiers admin so price + shipping rules can be Markets-aware. | Admin onboarding wizard (Phase 1I) |
| `read_orders` / `write_orders` | Read orders for activation-nudge "did this buyer actually order?" probes; write for the future order-approval workflow (Day 2 — currently unused write side). | `lib/shopify-orders.ts` |
| `read_payment_terms` / `write_payment_terms` | Reserved for the Day-2 PO/credit-limit features. Not exercised in v1; remove if not approved by App Store. | — |
| `read_products` / `write_products` | Read product metafield definitions (`b2b.b2b_only`, `b2b.case_quantity`, `b2b.min_order_qty`, `b2b.max_order_qty`). Write the metafield definitions themselves on install. | `lib/metafield-definitions.ts`, all three Functions |
| `read_shipping` / `write_shipping` | `delivery-customization` Function — hide/rename shipping rates per tier (free-shipping threshold, flat rate, pickup-only). | `extensions/functions/delivery-customization` |
| `read_themes` / `write_themes` | Surface Theme App Embed install state in the onboarding go-live checklist; the write scope is reserved for a future "auto-enable our blocks" wizard step and is **not exercised today**. | Onboarding step 7 (`apps/admin/app/routes/onboarding.tsx`) |
| `app/scopes_update` (compulsory) | Keeps the encrypted token in sync after a scope grant/revoke. | `routes/webhooks.ts` |

### 2.1 Scopes to trim before App Store submission

The four scopes flagged "not exercised today" — `read_files`,
`write_files`, `read_payment_terms`, `write_payment_terms`,
`write_themes` — should be dropped before Phase 5 (App Store
submission) and re-added only when the dependent feature actually
ships. Keeping them granted now slows down review and gives Built-for-
Shopify a reason to push back.

### 2.2 Webhooks we subscribe to

| Topic | Why | PII implication |
|---|---|---|
| `app/uninstalled` | Trigger the 30-day data-retention countdown | None — body has shop identifier only. |
| `app/scopes_update` | Re-encrypt the token if scopes change | None. |
| `shop/update` | Refresh `is_plus` (DECISIONS #11) | None. |
| `shop/redact` | Mandatory GDPR | Body holds shop identifier; queued and purged after the 7-day stand-down. |
| `customers/data_request` | Mandatory GDPR | Body holds customer email + GID; queued, exported via Resend within 30 days. |
| `customers/redact` | Mandatory GDPR | Body holds customer GID; queued and purged after the 7-day stand-down. |
| `companies/*` / `company_locations/*` | Day-2 cache invalidation (not exercised in v1) | None — Shopify objects, no contact PII in webhook bodies. |
| `orders/*` | Day-2 analytics (not exercised in v1) | Body holds buyer info; we currently log receipt only and do not persist. |
| `customers/create` / `customers/update` | Day-2 registration flow (not exercised in v1) | Body holds buyer info; we currently log receipt only and do not persist. |

---

## 3. Sub-processors

| Vendor | What they see | Why |
|---|---|---|
| **Cloudflare** (Workers, D1, KV, R2, Queues, Images, Access) | All app data; CF is our infrastructure provider. | Hosting. |
| **Shopify** | Everything Shopify already has (Companies, Catalogs, customers, orders). We only push back what Shopify gave us. | The platform we augment. |
| **Resend** | Outbound transactional email — application status, GDPR export, activation nudges. Sees buyer email + email body. | Email delivery; chosen per DECISIONS #16 Q5. |

No analytics, no error-tracking SaaS, no CDN beyond Cloudflare's own
edge. If any of these change, update this list in the same commit.

---

## 4. Data subject rights — how each is satisfied

| Right | Mechanism |
|---|---|
| Access (data export) | `customers/data_request` webhook → 1h queue stand-down → `lib/gdpr-purge.ts::exportCustomerData` → email JSON via Resend to the shop owner. The shop owner forwards to the data subject (Shopify's documented model). |
| Erasure | `customers/redact` (per-customer) and `shop/redact` (whole shop). Both queue with a 7-day stand-down so the merchant can cancel an accidental request from the admin. Implementation hard-deletes D1 rows, R2 objects, KV cache; no soft-delete tombstones. |
| Restriction / objection | Out of band — merchants pause processing by uninstalling. The `app/uninstalled` handler triggers the 30-day purge. |
| Portability | Same mechanism as Access — JSON export is structured and re-imports trivially. |
| Rectification | Buyers correct profile data via Shopify (we don't store a separate profile). Applicants can resume a draft via signed resume link and overwrite fields before re-submit. |

---

## 5. Open items (track in PLAN / DECISIONS as they harden)

- **Webhook body retention**. Today `webhook_log` stores headers only — bodies live in the queue and are dropped after processing. Adding a body sidecar would unlock operator-console replay but it would also stretch the retention story; if we do it, add a 30-day TTL up front.
- **R2 hard-delete cron** for soft-deleted assets older than 30 days (tracked in PLAN §4 backlog).
- **Webhook_log TTL** (tracked in PLAN cross-cutting backlog).
- **Rate-limit KV holding raw IP for ≤90s** — swap to hashed IP if a review demands it.
- **`MASTER_KEY` rotation runbook** — every encrypted token + every application blob is keyed on it. A rotation procedure exists in MANUAL_STEPS only as a warning today; turn it into a runnable runbook before GA.
