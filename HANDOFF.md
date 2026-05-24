# Handoff — PR #10 (`claude/phase-1d-1f-1g-tier-functions`)

Snapshot taken: 2026-05-24. Read this before continuing work on this branch.

## TL;DR

The code in this PR is functionally complete (138 tests passing, builds and
typechecks clean). The blocker is **environment / install state**, not code:
after `shopify app deploy` + worker redeploy + uninstall/reinstall + OAuth
re-authorisation, the embedded admin still reports "can't connect" when
fetching `/admin/*` endpoints from the Pages origin.

The next agent's job is to **diagnose the connection failure end-to-end**, not
to add features.

## What this PR ships

- Phase 1D (tier CRUD), 1F (cart-validation: minimums + step qty), 1G
  (delivery-customization) — Worker, Admin, and three Shopify Functions.
- Tier admin UI (`apps/admin/app/routes/tiers.tsx`) and Company-mapping UI
  (`apps/admin/app/routes/companies.tsx`) with a company selector (not raw
  GID input).
- CORS allowlist middleware (`apps/worker/src/middleware/cors.ts`) so the
  Pages origin can call `/admin/*` from the browser. Mounted *before*
  `sessionTokenMiddleware` so OPTIONS preflights succeed.
- Declarative webhook subscriptions in `shopify.app.toml` (added 29fdc9a) —
  previously **zero** webhooks were actually subscribed, including
  `app/uninstalled`. They are now declared but need `shopify app deploy` to
  push them.
- `/admin/token-health` diagnostic endpoint that introspects the encrypted
  token in D1 and tries a trivial `{ shop { name } }` query against Shopify.

## Current symptom (as of latest user report)

After the user:

1. Ran `shopify app deploy` (had to approve "customer sensitive data" access).
2. `git pull` + redeployed Worker (`wrangler deploy`) and Pages
   (`pnpm --filter @b2b/admin pages:deploy`).
3. Uninstalled the app from the dev store admin.
4. Reinstalled.
5. Hit the OAuth re-authorisation path manually.

…the admin panel still reports "can't connect" (i.e. the
`Failed to fetch` class of error we previously fixed with the CORS
middleware). It is **not** clear from the current report whether this is:

- CORS regressed,
- the Worker is unreachable,
- the Pages site is on the wrong URL (preview vs production — see history
  below; this was the bug that bit us once already),
- `ADMIN_ORIGIN` on the deployed Worker doesn't match the Pages URL the
  browser is actually loading from,
- the session-token middleware is rejecting requests (401, which the
  Admin code renders as "Failed to fetch" because the response has no CORS
  headers),
- or something else entirely (e.g. `id_token` not arriving at the
  loader).

Do not guess. Reproduce, capture the exact failure, then fix.

## Concrete first debugging steps

Have the user open DevTools → Network on the embedded admin page and
report, for the failing request:

1. **The request URL** (origin must match `ADMIN_ORIGIN` on the Worker).
2. **The response status** (0/CORS-blocked, 401, 404, 502, etc.).
3. **The response headers** — specifically `Access-Control-Allow-Origin`.
4. **The `Authorization` request header** — is `Bearer <jwt>` actually
   present? If not, App Bridge never produced a session token.

In parallel, hit the diagnostic endpoint from the browser's session:

```js
// In the embedded admin DevTools console:
fetch('/admin/token-health', {
  headers: { Authorization: `Bearer ${await shopify.idToken()}` },
}).then(r => r.json()).then(console.log)
```

It returns `{ row, token, shopify, reinstallUrl }`. The `shopify` field
includes the HTTP status and body excerpt of a live test query — if it's
401 "Invalid API key or access token" again, the reinstall did not produce
a working token (or the encrypted row in D1 is stale and the new token
wasn't written).

Then verify the Worker actually has what we think it has:

```bash
# Subscriptions actually subscribed?
shopify app info

# The current Worker is on the expected version?
wrangler deployments list

# ADMIN_ORIGIN env var on the deployed Worker matches the Pages URL?
wrangler tail --format=pretty
# …then trigger any /admin/* request from the browser and watch for
# the request, with the Origin header logged.

# D1 row for this shop — was uninstalled_at cleared on reinstall?
wrangler d1 execute b2b-companion --command \
  "SELECT id, shopify_domain, installed_at, uninstalled_at, \
   length(access_token_encrypted) AS tok_len FROM shops"
```

## Known traps (we have already been bitten by these)

1. **`wrangler pages deploy` defaults to a preview branch.** The
   `pages:deploy` script in `apps/admin/package.json` now forces
   `--branch=main`. If anyone deploys from a different branch or removes
   that flag, the production URL (`b2b-companion-admin.pages.dev`) silently
   serves stale JS while the new code sits on a preview URL like
   `https://claude-….b2b-companion-admin.pages.dev`. Verify with:
   ```bash
   curl -sI https://b2b-companion-admin.pages.dev | grep -i etag
   # then load the page and check the JS bundle hash in DevTools matches.
   ```
2. **CORS middleware ordering.** `adminCors` MUST run before
   `sessionTokenMiddleware` (see `apps/worker/src/routes/admin.ts`)
   otherwise OPTIONS preflights 401 and the browser reports
   `TypeError: Failed to fetch`. Tests in
   `apps/worker/src/middleware/cors.test.ts` cover this.
3. **`ADMIN_ORIGIN` mismatch.** Set in `apps/worker/wrangler.toml`. If the
   Pages URL changes (custom domain, staging), this needs to match exactly
   (no trailing slash, scheme included). Comma-separate for multiple
   origins.
4. **Webhook subscriptions were missing entirely** until commit `29fdc9a`.
   Before that, `app/uninstalled` never fired, so `shops.uninstalled_at`
   was never set on uninstall and the encrypted token kept being treated
   as live. Anyone debugging "stale token" issues on an environment that
   didn't run `shopify app deploy` after `29fdc9a` will be chasing a
   ghost.
5. **AES-GCM is authenticated.** If `MASTER_KEY` is rotated or different
   between environments, decryption *throws* — it doesn't return garbage.
   "Invalid API key" from Shopify is NOT a decryption failure; it means
   the decrypted token is just not valid at Shopify any more.

## Architecture, in one paragraph

OAuth, webhooks, and `/admin/*` API live on the **Worker**
(`b2b-companion.selling.workers.dev`). The embedded admin UI is a Remix
app served from **Cloudflare Pages**
(`b2b-companion-admin.pages.dev`). Shopify loads the Pages site in an
iframe with `id_token` in the query string; the Admin app uses App
Bridge 4 to mint session tokens and calls the Worker's `/admin/*`
endpoints directly from the browser (cross-origin). The Worker verifies
the session-token JWT, sets `shopDomain` in the context, and serves
JSON. All admin endpoints are gated by `adminCors` (allowlist) +
`sessionTokenMiddleware` in that order.

## File-of-interest map

| Area | File |
|---|---|
| App config (URLs, scopes, webhooks) | `shopify.app.toml` |
| Worker entry / routing | `apps/worker/src/index.ts`, `apps/worker/src/routes/admin.ts` |
| CORS allowlist | `apps/worker/src/middleware/cors.ts` |
| Session-token JWT verify | `apps/worker/src/middleware/session-token.ts` |
| Token-health diagnostic | `apps/worker/src/routes/admin-tiers.ts` (`/token-health`) |
| Token encryption (HKDF + AES-GCM) | `apps/worker/src/lib/crypto.ts`, `apps/worker/src/lib/shop-token.ts` |
| OAuth | `apps/worker/src/routes/oauth.ts` |
| Webhook ingest / dispatch | `apps/worker/src/routes/webhooks.ts` |
| `app/uninstalled` handler | `apps/worker/src/handlers/app-uninstalled.ts` |
| Tier CRUD UI | `apps/admin/app/routes/tiers.tsx` |
| Company mapping UI | `apps/admin/app/routes/companies.tsx` |
| Pages deploy script | `apps/admin/package.json` (`pages:deploy`) |
| Setup runbook | `MANUAL_STEPS.md` |

## What is NOT yet verified end-to-end on the live environment

- Webhook delivery: `app/uninstalled` actually firing on uninstall, and
  `shops.uninstalled_at` being set. Run `wrangler tail` during an
  uninstall to confirm.
- Tier CRUD round-trip from the embedded admin (blocked on the connect
  issue above).
- Company mapping mirroring to the Company `b2b.tier_id` metafield via
  the `_internal/mirror-company-tier` queue job.
- Functions running against a real cart in a dev store.

## Suggested order of operations for the next session

1. Reproduce the "can't connect" error with DevTools open; capture exact
   request/response.
2. From that, decide whether the failure is at the network layer (wrong
   URL / unreachable), CORS layer (missing allow-origin), auth layer
   (401), or app layer (500/502).
3. If the token-health diagnostic still returns 401 after a clean
   reinstall, walk the OAuth callback (`apps/worker/src/routes/oauth.ts`)
   step by step to confirm the new token is being persisted to the row
   that the admin lookup actually reads.
4. Only after the admin panel can list tiers do we proceed with the
   manual acceptance checklist in PR #10's "Test plan".

## Do not, without checking first

- Rotate `MASTER_KEY` (will brick every encrypted token in D1).
- Force-push to `main` or merge this PR — it is gated on the manual
  acceptance checklist that we cannot yet run.
- Delete the row in `shops` to "start fresh" — it is the only thing
  binding the encrypted token to the install. Uninstall + reinstall
  through Shopify is the supported way.
