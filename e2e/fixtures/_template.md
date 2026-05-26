# Fixture template

Each theme directory contains two PDP captures:

- `pdp.html` — a regular product viewed by a logged-out (non-B2B) visitor.
- `pdp.b2b-only.html` — a product whose `b2b.b2b_only` metafield is `true`,
  also viewed by a non-B2B visitor. The Liquid-side `<style>` hide rule from
  `b2b-price.liquid:31-35` is rendered inline so the theme's price/form
  selectors disappear from view, and the block carries `data-b2b-only="true"`.

Both fixtures pull the same `../b2b-price.js` so changes to the canonical
asset (under `extensions/theme-app-extension/assets/`) propagate via
`scripts/sync-asset.mjs`.

The captures are deliberately minimal — they include only the DOM the
`b2b-price` block interacts with (or the Liquid hide rule targets) plus
enough surrounding markup to look like a real PDP for each theme. The
selectors per theme are:

| Theme    | Form selector            | Price selectors                          |
|----------|--------------------------|------------------------------------------|
| Dawn     | `.product-form`          | `.price`, `.price-item--regular`         |
| Horizon  | `.product-form`          | `.price`, `.product__price`              |
| Impulse  | `.product-single__form`  | `.product__price`, `.product-single__price` |
| Prestige | `.product-form`          | `.price`, `.ProductMeta__Price`          |

The block's defence-in-depth hide rule
(`b2b-price.liquid:32-34`) covers `.product-form, .product__price, .price,
.product-form__buttons` — common across all four themes. Per-theme
selectors above are documented for fixture authors; the e2e tests rely on
the common rule.
