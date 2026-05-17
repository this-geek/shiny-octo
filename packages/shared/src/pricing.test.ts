import { describe, it, expect } from 'vitest';
import { applyTierDiscount, calcCartDiscount, validateOrderMinimums } from './pricing.js';
import type { Tier, CartLine } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTier(overrides: Partial<Tier> = {}): Tier {
  return {
    id: 1,
    shop_id: 1,
    name: 'Standard',
    discount_type: 'none',
    discount_value: 0,
    min_order_value: null,
    min_order_units: null,
    free_shipping_threshold: null,
    flat_shipping_amount: null,
    pickup_only: false,
    priority: 0,
    deleted_at: null,
    ...overrides,
  };
}

function makeLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    variant_id: 'v1',
    price: 100,
    quantity: 1,
    eligible_for_tier: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applyTierDiscount
// ---------------------------------------------------------------------------

describe('applyTierDiscount', () => {
  it('applies a percent discount: 100 * 20% off = 80', () => {
    const tier = makeTier({ discount_type: 'percent', discount_value: 20 });
    expect(applyTierDiscount(100, tier)).toBe(80);
  });

  it('applies a percent discount correctly for non-round numbers', () => {
    const tier = makeTier({ discount_type: 'percent', discount_value: 10 });
    expect(applyTierDiscount(99, tier)).toBeCloseTo(89.1);
  });

  it('applies an amount discount: 100 - 15 = 85', () => {
    const tier = makeTier({ discount_type: 'amount', discount_value: 15 });
    expect(applyTierDiscount(100, tier)).toBe(85);
  });

  it('returns price unchanged when discount_type is none', () => {
    const tier = makeTier({ discount_type: 'none', discount_value: 0 });
    expect(applyTierDiscount(100, tier)).toBe(100);
  });

  it('clamps price to 0 when amount discount exceeds price', () => {
    const tier = makeTier({ discount_type: 'amount', discount_value: 200 });
    expect(applyTierDiscount(100, tier)).toBe(0);
  });

  it('clamps price to 0 when percent discount is 100', () => {
    const tier = makeTier({ discount_type: 'percent', discount_value: 100 });
    expect(applyTierDiscount(100, tier)).toBe(0);
  });

  it('never returns a negative price even with huge amount discount', () => {
    const tier = makeTier({ discount_type: 'amount', discount_value: 9999999 });
    expect(applyTierDiscount(1, tier)).toBe(0);
  });

  it('handles a price of 0 without going negative', () => {
    const tier = makeTier({ discount_type: 'amount', discount_value: 50 });
    expect(applyTierDiscount(0, tier)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// calcCartDiscount
// ---------------------------------------------------------------------------

describe('calcCartDiscount', () => {
  it('discounts only eligible lines', () => {
    const tier = makeTier({ discount_type: 'percent', discount_value: 50 });
    const lines: CartLine[] = [
      makeLine({ price: 100, quantity: 1, eligible_for_tier: true }),
      makeLine({ variant_id: 'v2', price: 200, quantity: 1, eligible_for_tier: false }),
    ];
    const result = calcCartDiscount(lines, tier);
    // eligible: 100 → 50; ineligible: 200 stays 200
    expect(result.totalBefore).toBe(300);
    expect(result.totalAfter).toBe(250);
    expect(result.discountAmount).toBe(50);
  });

  it('discounts multi-quantity lines correctly', () => {
    const tier = makeTier({ discount_type: 'percent', discount_value: 20 });
    const lines: CartLine[] = [
      makeLine({ price: 100, quantity: 3, eligible_for_tier: true }),
    ];
    const result = calcCartDiscount(lines, tier);
    expect(result.totalBefore).toBe(300);
    expect(result.totalAfter).toBe(240);
    expect(result.discountAmount).toBe(60);
  });

  it('returns zero discount when no lines are eligible', () => {
    const tier = makeTier({ discount_type: 'percent', discount_value: 50 });
    const lines: CartLine[] = [
      makeLine({ price: 100, quantity: 2, eligible_for_tier: false }),
    ];
    const result = calcCartDiscount(lines, tier);
    expect(result.totalBefore).toBe(200);
    expect(result.totalAfter).toBe(200);
    expect(result.discountAmount).toBe(0);
  });

  it('returns zero totals for an empty cart', () => {
    const tier = makeTier({ discount_type: 'percent', discount_value: 10 });
    const result = calcCartDiscount([], tier);
    expect(result.totalBefore).toBe(0);
    expect(result.totalAfter).toBe(0);
    expect(result.discountAmount).toBe(0);
  });

  it('handles none discount type — no change', () => {
    const tier = makeTier({ discount_type: 'none', discount_value: 0 });
    const lines = [makeLine({ price: 50, quantity: 2 })];
    const result = calcCartDiscount(lines, tier);
    expect(result.totalBefore).toBe(100);
    expect(result.totalAfter).toBe(100);
    expect(result.discountAmount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateOrderMinimums
// ---------------------------------------------------------------------------

describe('validateOrderMinimums', () => {
  it('passes when both minimums are null', () => {
    const tier = makeTier({ min_order_value: null, min_order_units: null });
    const lines = [makeLine({ price: 10, quantity: 1 })];
    expect(validateOrderMinimums(lines, tier).valid).toBe(true);
  });

  it('fails min_order_value using discounted total', () => {
    // 10% off 100 = 90; minimum is 95 → fail
    const tier = makeTier({
      discount_type: 'percent',
      discount_value: 10,
      min_order_value: 95,
    });
    const lines = [makeLine({ price: 100, quantity: 1 })];
    const result = validateOrderMinimums(lines, tier);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/95/);
  });

  it('passes min_order_value when discounted total meets threshold', () => {
    // 10% off 200 = 180; minimum is 150 → pass
    const tier = makeTier({
      discount_type: 'percent',
      discount_value: 10,
      min_order_value: 150,
    });
    const lines = [makeLine({ price: 200, quantity: 1 })];
    expect(validateOrderMinimums(lines, tier).valid).toBe(true);
  });

  it('fails min_order_units when eligible qty is below minimum', () => {
    const tier = makeTier({ min_order_units: 24 });
    const lines = [
      makeLine({ price: 10, quantity: 18, eligible_for_tier: true }),
    ];
    const result = validateOrderMinimums(lines, tier);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/24/);
    expect(result.reason).toMatch(/18/);
  });

  it('passes min_order_units exactly at threshold', () => {
    const tier = makeTier({ min_order_units: 24 });
    const lines = [makeLine({ price: 10, quantity: 24, eligible_for_tier: true })];
    expect(validateOrderMinimums(lines, tier).valid).toBe(true);
  });

  it('counts only eligible lines toward min_order_units', () => {
    const tier = makeTier({ min_order_units: 10 });
    const lines: CartLine[] = [
      makeLine({ price: 10, quantity: 6, eligible_for_tier: true }),
      makeLine({ variant_id: 'v2', price: 10, quantity: 20, eligible_for_tier: false }),
    ];
    // eligible = 6 < 10 → fail
    const result = validateOrderMinimums(lines, tier);
    expect(result.valid).toBe(false);
  });

  it('returns valid:true for empty cart when minimums are null', () => {
    const tier = makeTier({ min_order_value: null, min_order_units: null });
    expect(validateOrderMinimums([], tier).valid).toBe(true);
  });

  it('fails min_order_value for empty cart when minimum is set', () => {
    const tier = makeTier({ min_order_value: 50 });
    expect(validateOrderMinimums([], tier).valid).toBe(false);
  });
});
