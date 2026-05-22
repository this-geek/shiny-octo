import type { CartLine, Tier } from './types.js';

/**
 * Apply a single tier's discount to a base price.
 * Returns the discounted price, clamped to a minimum of 0.
 */
export function applyTierDiscount(
  basePrice: number,
  tier: Pick<Tier, 'discount_type' | 'discount_value'>,
): number {
  let discounted: number;

  switch (tier.discount_type) {
    case 'percent':
      discounted = basePrice * (1 - tier.discount_value / 100);
      break;
    case 'amount':
      discounted = basePrice - tier.discount_value;
      break;
    case 'none':
      discounted = basePrice;
      break;
    default: {
      // exhaustive check — TypeScript will flag unhandled variants
      const _exhaustive: never = tier.discount_type;
      discounted = basePrice;
    }
  }

  return Math.max(0, discounted);
}

/**
 * Calculate the total discount across all cart lines.
 * Only lines marked eligible_for_tier receive the tier discount.
 */
export function calcCartDiscount(
  lines: CartLine[],
  tier: Tier,
): { totalBefore: number; totalAfter: number; discountAmount: number } {
  let totalBefore = 0;
  let totalAfter = 0;

  for (const line of lines) {
    const lineBefore = line.price * line.quantity;
    totalBefore += lineBefore;

    if (line.eligible_for_tier) {
      const discountedPrice = applyTierDiscount(line.price, tier);
      totalAfter += discountedPrice * line.quantity;
    } else {
      totalAfter += lineBefore;
    }
  }

  return {
    totalBefore,
    totalAfter,
    discountAmount: totalBefore - totalAfter,
  };
}

/**
 * Validate that the cart meets the tier's order minimums.
 * min_order_value is checked against the discounted total (totalAfter).
 * min_order_units is checked against the total quantity of eligible lines.
 */
export function validateOrderMinimums(
  lines: CartLine[],
  tier: Tier,
): { valid: boolean; reason?: string } {
  const { totalAfter } = calcCartDiscount(lines, tier);

  const eligibleUnits = lines
    .filter(l => l.eligible_for_tier)
    .reduce((sum, l) => sum + l.quantity, 0);

  if (tier.min_order_value !== null && totalAfter < tier.min_order_value) {
    return {
      valid: false,
      reason: `Minimum order value for ${tier.name} tier is ${tier.min_order_value}; your cart total is ${totalAfter.toFixed(2)}`,
    };
  }

  if (tier.min_order_units !== null && eligibleUnits < tier.min_order_units) {
    return {
      valid: false,
      reason: `Minimum order units for ${tier.name} tier is ${tier.min_order_units}; you have ${eligibleUnits}`,
    };
  }

  return { valid: true };
}
