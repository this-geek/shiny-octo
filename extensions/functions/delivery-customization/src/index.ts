/**
 * delivery-customization Shopify Function — Phase 1 implementation
 *
 * Plus-mode invariant (DECISIONS / §3): see cart-transform for the same gate.
 *
 * TODO Phase 1D: Implement full delivery customization logic, reading tier
 * data from the buyer identity context and applying delivery operations.
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
