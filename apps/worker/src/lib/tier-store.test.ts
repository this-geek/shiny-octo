import { describe, it, expect } from 'vitest';
import { TierValidationError, validateTierInput } from './tier-store.js';

describe('validateTierInput', () => {
  const base = {
    name: 'Gold',
    discount_type: 'percent' as const,
    discount_value: 10,
    min_order_value: null,
    min_order_units: null,
    free_shipping_threshold: null,
    flat_shipping_amount: null,
    pickup_only: false,
    priority: 0,
  };

  it('accepts a minimal valid percent tier', () => {
    const out = validateTierInput(base);
    expect(out.name).toBe('Gold');
    expect(out.discount_type).toBe('percent');
  });

  it('rejects discount_value > 100 for percent', () => {
    expect(() =>
      validateTierInput({ ...base, discount_value: 110 }),
    ).toThrow(TierValidationError);
  });

  it('rejects an empty name', () => {
    expect(() => validateTierInput({ ...base, name: '' })).toThrow(TierValidationError);
  });

  it('rejects an unknown discount_type', () => {
    expect(() => validateTierInput({ ...base, discount_type: 'bogus' })).toThrow(
      TierValidationError,
    );
  });

  it('rejects a negative discount_value', () => {
    expect(() => validateTierInput({ ...base, discount_value: -1 })).toThrow(
      TierValidationError,
    );
  });

  it('rejects a non-integer priority', () => {
    expect(() => validateTierInput({ ...base, priority: 1.5 })).toThrow(
      TierValidationError,
    );
  });

  it('rejects a negative min_order_value', () => {
    expect(() =>
      validateTierInput({ ...base, min_order_value: -50 }),
    ).toThrow(TierValidationError);
  });

  it('accepts amount discount with value > 100', () => {
    const out = validateTierInput({ ...base, discount_type: 'amount', discount_value: 500 });
    expect(out.discount_value).toBe(500);
  });

  it('accepts pickup_only with shipping thresholds set', () => {
    const out = validateTierInput({
      ...base,
      pickup_only: true,
      free_shipping_threshold: 200,
      flat_shipping_amount: 10,
    });
    expect(out.pickup_only).toBe(true);
    expect(out.free_shipping_threshold).toBe(200);
  });
});
