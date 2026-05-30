# @b2b/e2e — Playwright acceptance suite

Closes the last remaining checkbox of PLAN.md Phase 1B: direct-URL guard,
no FOUC, ≤500ms post-login reveal, on Dawn + Horizon + Impulse + Prestige.

## Running

```sh
pnpm install
pnpm --filter @b2b/e2e exec playwright install --with-deps chromium
pnpm --filter @b2b/e2e test
```

The suite is hermetic: each test loads a static PDP fixture under
`fixtures/<theme>/` via `file://` and mocks the `/tier-context` App Proxy
endpoint with `page.route('**/tier-context', …)`. No dev store or
network required.

## Layout

```
fixtures/
  b2b-price.js                  # checked-in copy of the canonical asset
  <theme>/
    pdp.html                    # non-B2B visitor, regular product
    pdp.b2b-only.html           # non-B2B visitor, b2b_only product
    collection.html             # listing page: 3 cards + site-wide controller
tests/
  direct-url-guard.spec.ts      # b2b-price.js:67-71
  no-fouc.spec.ts               # b2b-price.js:84-87 (cache hit path)
  reveal-latency.spec.ts        # b2b-price.js:89-96 (cache miss path)
  theme-matrix.spec.ts          # hide-rule selector presence per theme
  site-wide-pricing.spec.ts     # Phase 1K overlay: percent + amount + observer
scripts/
  sync-asset.mjs                # pretest guard: fixture copy ≡ canonical
  capture-fixtures.mjs          # manual fixture refresh stub
```

## Asset lockstep

`fixtures/b2b-price.js` is a byte-for-byte copy of
`extensions/theme-app-extension/assets/b2b-price.js`. The `pretest` hook
runs `scripts/sync-asset.mjs --check` and fails CI if they diverge.

When the canonical asset changes, refresh the fixture copy:

```sh
pnpm --filter @b2b/e2e run test:update-fixtures
```

This mirrors the parity-test convention already used by
`extensions/theme-app-extension/assets/b2b-price.test.js`.

## Refreshing fixtures

Run when Shopify ships a major theme version that changes price/form
selectors, when we add a new theme to the supported matrix, or when the
App Proxy subpath or block schema changes.

1. Install the latest version of each theme on a dev store with the app
   installed and the **B2B Tier Price** app embed enabled.
2. Visit a regular product as a logged-out visitor; in DevTools →
   Elements, copy the outer HTML and save as `fixtures/<theme>/pdp.html`.
3. Visit a `b2b_only=true` product as a logged-out visitor; save as
   `fixtures/<theme>/pdp.b2b-only.html`.
4. In each saved file: strip third-party scripts (analytics, Shopify
   bundle), rewrite the `b2b-price.js` script src to
   `../b2b-price.js`, and verify the `[data-b2b-price-block]` div is
   present with all required `data-*` attributes.
5. Run `pnpm --filter @b2b/e2e test` and fix selector drift if any.

A scripted version of this lives at `scripts/capture-fixtures.mjs` —
currently a stub; implement when we have a stable dev store to point at.

## Live-store smoke

The hermetic suite covers behaviour against captured DOM. The
pre-pilot acceptance checklist in `MANUAL_STEPS.md §10.5` is the
one-time live-store signoff: install the app on a real dev store with
the four themes, log in as an approved B2B buyer, and walk the same
four conditions on the merchant's actual storefront.
