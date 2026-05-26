// Unit tests for b2b-minimums.js snap-quantity logic.
//
// The browser file is an IIFE (no exports). We re-implement snapQuantity
// here byte-for-byte and assert it satisfies the per-line constraints
// the cart-validation Function will enforce (case_quantity multiple,
// min_order_qty, max_order_qty). Any change to the browser snap math
// must update this re-implementation in lockstep.

import { describe, it, expect } from 'vitest';

function browserSnapQuantity(qty, opts) {
  const caseQty = opts.caseQty || null;
  const minQty = opts.minQty || null;
  const maxQty = opts.maxQty || null;

  let q = Math.max(1, Math.floor(Number(qty) || 1));
  if (caseQty) q = Math.ceil(q / caseQty) * caseQty;
  if (minQty && q < minQty) {
    q = caseQty ? Math.ceil(minQty / caseQty) * caseQty : minQty;
  }
  if (maxQty && q > maxQty) {
    q = caseQty ? Math.floor(maxQty / caseQty) * caseQty : maxQty;
  }
  return q;
}

describe('b2b-minimums snapQuantity', () => {
  it('no constraints — returns floor with minimum of 1', () => {
    expect(browserSnapQuantity(5, {})).toBe(5);
    expect(browserSnapQuantity(0, {})).toBe(1);
    expect(browserSnapQuantity(-3, {})).toBe(1);
    expect(browserSnapQuantity(2.7, {})).toBe(2);
  });

  it('case_quantity — rounds up to nearest multiple', () => {
    expect(browserSnapQuantity(1, { caseQty: 6 })).toBe(6);
    expect(browserSnapQuantity(7, { caseQty: 6 })).toBe(12);
    expect(browserSnapQuantity(12, { caseQty: 6 })).toBe(12);
  });

  it('min_order_qty — snaps up to minimum', () => {
    expect(browserSnapQuantity(2, { minQty: 5 })).toBe(5);
    expect(browserSnapQuantity(10, { minQty: 5 })).toBe(10);
  });

  it('case_quantity + min_order_qty — minimum is rounded up to case multiple', () => {
    expect(browserSnapQuantity(1, { caseQty: 6, minQty: 10 })).toBe(12);
    expect(browserSnapQuantity(7, { caseQty: 6, minQty: 10 })).toBe(12);
    expect(browserSnapQuantity(13, { caseQty: 6, minQty: 10 })).toBe(18);
  });

  it('max_order_qty — clamps down to maximum', () => {
    expect(browserSnapQuantity(50, { maxQty: 20 })).toBe(20);
    expect(browserSnapQuantity(10, { maxQty: 20 })).toBe(10);
  });

  it('case_quantity + max_order_qty — maximum rounds down to case multiple', () => {
    expect(browserSnapQuantity(50, { caseQty: 6, maxQty: 20 })).toBe(18);
    expect(browserSnapQuantity(50, { caseQty: 6, maxQty: 24 })).toBe(24);
  });

  it('all three — snap respects every constraint', () => {
    const opts = { caseQty: 6, minQty: 12, maxQty: 30 };
    expect(browserSnapQuantity(1, opts)).toBe(12);
    expect(browserSnapQuantity(13, opts)).toBe(18);
    expect(browserSnapQuantity(100, opts)).toBe(30);
    expect(browserSnapQuantity(30, opts)).toBe(30);
  });

  it('invalid numeric input falls back to 1', () => {
    expect(browserSnapQuantity('abc', {})).toBe(1);
    expect(browserSnapQuantity(NaN, {})).toBe(1);
    expect(browserSnapQuantity(undefined, {})).toBe(1);
  });
});
