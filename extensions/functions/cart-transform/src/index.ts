/**
 * cart-transform Shopify Function — Phase 1 implementation
 *
 * Plus-mode invariant (DECISIONS / §3): when the shop is on Shopify Plus we
 * never modify the cart. Plus has unlimited native Catalogs assigned directly
 * to Company Locations; our Function would double-apply discounts.
 *
 * The Plus flag is read from Shop metafield `b2b.is_plus`, mirrored by the
 * Worker on OAuth install and every `shop/update` webhook. Functions cannot
 * query our D1, so Shop metafields are how the Worker hands state to them.
 *
 * TODO Phase 1D: Implement full cart-transform logic using shared pricing module.
 */

export interface FunctionInput {
  shop: { metafield: { value: string } | null };
}

export interface FunctionResult {
  operations: unknown[];
}

export function run(input: FunctionInput): FunctionResult {
  if (input.shop.metafield?.value === 'true') {
    return { operations: [] };
  }
  return { operations: [] };
}
