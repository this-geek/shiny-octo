#!/usr/bin/env node
// Manual fixture refresh tool. Walks a Shopify dev store PDP on each of
// Dawn / Horizon / Impulse / Prestige, grabs the rendered HTML with the
// B2B Tier Price app embed enabled, strips Shopify analytics + theme JS,
// rewrites the b2b-price.js script src to the local fixture copy, and
// writes the result under fixtures/<theme>/pdp[.b2b-only].html.
//
// Not wired into CI. Run when:
//   • Shopify ships a major theme version that changes price/form selectors
//   • we add a new theme to the supported matrix
//   • the App Proxy subpath or block schema changes
//
// Usage:
//   STORE=mystore.myshopify.com \
//   ADMIN_TOKEN=shpat_xxx \
//   REGULAR_PRODUCT_HANDLE=widget \
//   B2B_ONLY_PRODUCT_HANDLE=trade-widget \
//   node scripts/capture-fixtures.mjs

console.error(
  [
    'capture-fixtures: stub — implement against a dev store before the next theme refresh.',
    'See e2e/README.md §"Refreshing fixtures" for the manual procedure (browser DevTools save-as).',
  ].join('\n'),
);
process.exit(1);
