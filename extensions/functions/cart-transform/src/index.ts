/**
 * cart-transform Shopify Function — Phase 1 implementation
 *
 * Reads the Company metafield `b2b.tier_id` to identify the buyer's tier,
 * fetches the tier discount from our app's configuration, and applies it to
 * eligible cart lines as a percentage or fixed-amount discount operation.
 *
 * Disabled on Plus shops: when the Company metafield `b2b.is_plus` is true,
 * this Function returns early with no operations. Plus shops use unlimited
 * native Catalogs assigned directly to Company Locations — our Function
 * would double-apply discounts.
 *
 * Pricing logic shared with the storefront block lives in `packages/shared`
 * so the two cannot drift.
 *
 * TODO Phase 1D: Implement full cart-transform logic using shared pricing module.
 */

export function run(_input: unknown): unknown {
  // TODO: Phase 1D implementation
  return { operations: [] };
}
