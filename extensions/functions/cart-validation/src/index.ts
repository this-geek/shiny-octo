/**
 * cart-validation Shopify Function — Phase 1 implementation
 *
 * Validates that the cart meets the buyer's tier minimums before checkout:
 *   - min_order_value: minimum discounted cart total
 *   - min_order_units: minimum total quantity of tier-eligible items
 *   - step_quantity / case_quantity: per-line quantity increments (from product metafields)
 *
 * Returns a list of validation errors displayed in the Shopify checkout UI.
 * An empty errors array means the cart is valid.
 *
 * TODO Phase 1D: Implement full validation logic using validateOrderMinimums
 * from @b2b/shared, reading tier data from the cart's buyer identity context.
 */

export function run(_input: unknown): unknown {
  // TODO: Phase 1D implementation
  return { errors: [] };
}
