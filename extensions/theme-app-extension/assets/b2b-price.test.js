// Parity test: ensures the storefront block's pricing math matches
// packages/shared/src/pricing.ts. Both targets must compute identical
// discounted prices for the same input — drift = checkout mismatch (P0 bug).
//
// The browser file b2b-price.js is an IIFE (no exports) and runs against
// document. We re-implement applyTierDiscount here byte-for-byte from
// b2b-price.js and assert it agrees with the @b2b/shared implementation
// across a property-style battery of cases. Any change to the browser
// math must update this re-implementation in lockstep.

import { describe, it, expect } from 'vitest';
import { applyTierDiscount as sharedApply } from '@b2b/shared';

function browserApplyTierDiscount(basePrice, discountType, discountValue) {
  let discounted = basePrice;
  if (discountType === 'percent') {
    discounted = basePrice * (1 - discountValue / 100);
  } else if (discountType === 'amount') {
    discounted = basePrice - discountValue;
  }
  return Math.max(0, discounted);
}

describe('b2b-price.js / @b2b/shared parity', () => {
  const cases = [
    { type: 'percent', value: 0, base: 100 },
    { type: 'percent', value: 10, base: 99 },
    { type: 'percent', value: 20, base: 100 },
    { type: 'percent', value: 100, base: 100 },
    { type: 'amount', value: 0, base: 100 },
    { type: 'amount', value: 15, base: 100 },
    { type: 'amount', value: 200, base: 100 },
    { type: 'none', value: 0, base: 100 },
  ];

  cases.forEach(({ type, value, base }) => {
    it(`${type} ${value} on ${base} matches @b2b/shared`, () => {
      const browser = browserApplyTierDiscount(base, type, value);
      const shared = sharedApply(base, {
        discount_type: type,
        discount_value: value,
      });
      expect(browser).toBeCloseTo(shared, 8);
    });
  });
});
