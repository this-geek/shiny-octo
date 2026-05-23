/**
 * cart-validation Shopify Function — Phase 1 implementation
 *
 * Plus-mode invariant (DECISIONS / §3): when the shop is on Shopify Plus we
 * never block checkout. See cart-transform for the same gate.
 *
 * TODO Phase 1D: Implement full validation logic using validateOrderMinimums
 * from @b2b/shared, reading tier data from the cart's buyer identity context.
 */

export interface FunctionInput {
  shop: { metafield: { value: string } | null };
}

export interface FunctionResult {
  errors: unknown[];
}

export function run(input: FunctionInput): FunctionResult {
  if (input.shop.metafield?.value === 'true') {
    return { errors: [] };
  }
  return { errors: [] };
}
