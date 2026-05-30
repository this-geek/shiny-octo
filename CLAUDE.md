# Claude Context — shiny-octo

## What this repo is

A Shopify public app that augments Shopify's native B2B features. **Augments,
never replaces** — Companies, Catalogs, Markets, payment terms remain
Shopify's. The differentiator is the **dealer asset portal**; tier pricing,
minimums, shipping rules, and a registration/approval flow round it out.

Phases 0–2 are substantially implemented and tested: a Cloudflare Worker
(Hono) API, a Remix admin on Cloudflare Pages, a Theme App Extension, three
Shopify Functions, and the dealer asset portal (Worker-hosted via App Proxy,
with a customer-account link block surfacing it). A few P0s are still deferred
— Cloudflare resource provisioning, Cloudflare Images variant generation, and
the `/_ops` operator console; Phase 3 onward is the Day-2 feature backlog. See
`PLAN.md` for checkbox-level status, `HANDOFF.md` for the latest session
snapshot, and `MANUAL_STEPS.md` for deploy/config steps.

## Canonical documents

- `b2b-app-requirements.md` — full requirements (v0.1).
- `DECISIONS.md` — resolutions for ambiguities in the requirements; each
  decision has a "trigger to revisit" condition.
- `PLAN.md` — phased, checkbox-tracked implementation plan. Update checkboxes
  as work lands.
- `HANDOFF.md` — per-session snapshot: what's built, what's deployable,
  what's left, and the landmines.
- `MANUAL_STEPS.md` — deployment & configuration runbook (Shopify Partner
  dashboard, Cloudflare resources, secrets, DNS) — everything that can't be
  done from code.

When the first three disagree: requirements describe intent, DECISIONS
overrides ambiguous detail, PLAN sequences the work. HANDOFF and MANUAL_STEPS
are operational, not canonical — defer to them only for status and deploy
steps respectively.

## Stack

- Cloudflare Workers (Hono), D1, KV, R2, Queues, Cloudflare Images.
- Shopify: Admin GraphQL, Theme App Extension, Shopify Functions
  (cart-transform, cart-validation, delivery-customization), Remix admin on
  Cloudflare Pages with App Bridge 4 + Polaris, Customer Account API for
  buyers.
- pnpm monorepo: `apps/worker`, `apps/admin`, `extensions/...`,
  `packages/shared`.

## Working norms

- Shopify is the source of truth for Companies, Locations, Catalogs, payment
  terms. Never duplicate them locally; mirror only what a Shopify Function
  needs (e.g. `b2b.tier_id` Company metafield).
- Every D1 query, KV key, and R2 path includes `shop_id`. Cross-tenant
  access must be impossible by construction.
- Webhooks: raw-body HMAC verify before parsing; idempotent by
  `X-Shopify-Webhook-Id`.
- Tokens, application form data, and PII are AES-GCM encrypted at rest with
  per-shop HKDF-derived keys.
- No PII in logs. Hash customer IDs.
- Server-side `fetch` targets — including the Worker base URL — must come
  from `context.cloudflare.env` (or equivalent server-only config), never
  from request input (form fields, query string, JSON body, headers). The
  only request-sourced values that may reach an outbound `fetch` are path
  segments and bearer/session tokens, and only when the origin/host is
  fixed server-side. See issue #30.
- Pricing logic lives in `packages/shared` and is compiled for both the
  Function and the storefront block so they cannot drift.
- On Shopify Plus, the tier-discount Function is disabled; the admin shows a
  one-time banner explaining why.

## Conventions for changes

- **TDD is the default.** Write the failing test first, then the minimum code
  to make it pass, then refactor. A commit that adds behaviour without an
  accompanying test should be rare and explained in the message.
  - Unit tests for pure logic (pricing math, visibility resolution,
    minimum validation).
  - Integration tests for webhook signature verification and GraphQL paths.
  - Playwright for the apply → approve → first-order flow and other E2E
    journeys.
  - Shopify's Function testing harness for cart-transform, cart-validation,
    delivery-customization.
- Keep edits scoped. Don't refactor unrelated code in a feature PR.
- No comments unless the *why* is non-obvious.
- Update `PLAN.md` checkboxes in the same commit that lands the work.

## Out of scope

Multi-currency beyond Shopify Markets, headless storefronts (v1), EDI/ERP,
POS B2B pricing, marketplaces, replatforming from Magento/Woo/SAP. Full list
in §11 of the requirements.
