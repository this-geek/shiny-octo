import { describe, it, expect } from 'vitest';
import { run, type FunctionInput, type ValidationLine } from './index.js';

function tiersConfigValue(tiers: unknown[]): { value: string } {
  return { value: JSON.stringify({ version: 1, tiers }) };
}

function line(overrides: Partial<ValidationLine> = {}): ValidationLine {
  return {
    id: 'gid://line/1',
    quantity: 1,
    cost: { amountPerQuantity: { amount: '100.00' } },
    merchandise: {
      title: 'Widget',
      product: { caseQuantity: null, minOrderQty: null, maxOrderQty: null },
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<FunctionInput> = {}): FunctionInput {
  return {
    shop: { isPlus: { value: 'false' }, tiersConfig: null },
    cart: { lines: [line()], buyerIdentity: null },
    ...overrides,
  };
}

describe('cart-validation: Plus-mode gate', () => {
  it('returns no errors when shop.isPlus is "true"', () => {
    expect(
      run(
        makeInput({
          shop: {
            isPlus: { value: 'true' },
            tiersConfig: tiersConfigValue([
              { id: 1, name: 'Gold', discount_type: 'percent', discount_value: 10, min_order_value: 1000, min_order_units: null },
            ]),
          },
          cart: {
            lines: [line()], // total 100, well below 1000
            buyerIdentity: {
              purchasingCompany: { company: { metafield: { value: '1' } } },
            },
          },
        }),
      ),
    ).toEqual({ errors: [] });
  });
});

describe('cart-validation: per-line product constraints', () => {
  it('flags case quantity violation', () => {
    const result = run(
      makeInput({
        cart: {
          lines: [
            line({
              quantity: 7,
              merchandise: {
                title: 'Box of bolts',
                product: {
                  caseQuantity: { value: '6' },
                  minOrderQty: null,
                  maxOrderQty: null,
                },
              },
            }),
          ],
          buyerIdentity: null,
        },
      }),
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/multiples of 6/);
    expect(result.errors[0].target).toBe('gid://line/1');
  });

  it('flags below-minimum line quantity', () => {
    const result = run(
      makeInput({
        cart: {
          lines: [
            line({
              quantity: 1,
              merchandise: {
                title: 'Widget',
                product: {
                  caseQuantity: null,
                  minOrderQty: { value: '10' },
                  maxOrderQty: null,
                },
              },
            }),
          ],
          buyerIdentity: null,
        },
      }),
    );
    expect(result.errors[0].message).toMatch(/minimum order quantity of 10/);
  });

  it('flags above-maximum line quantity', () => {
    const result = run(
      makeInput({
        cart: {
          lines: [
            line({
              quantity: 100,
              merchandise: {
                title: 'Widget',
                product: {
                  caseQuantity: null,
                  minOrderQty: null,
                  maxOrderQty: { value: '50' },
                },
              },
            }),
          ],
          buyerIdentity: null,
        },
      }),
    );
    expect(result.errors[0].message).toMatch(/maximum order quantity of 50/);
  });

  it('emits no errors when a line satisfies all product constraints', () => {
    const result = run(
      makeInput({
        cart: {
          lines: [
            line({
              quantity: 12,
              merchandise: {
                title: 'Widget',
                product: {
                  caseQuantity: { value: '6' },
                  minOrderQty: { value: '6' },
                  maxOrderQty: { value: '24' },
                },
              },
            }),
          ],
          buyerIdentity: null,
        },
      }),
    );
    expect(result.errors).toEqual([]);
  });
});

describe('cart-validation: tier minimums', () => {
  const TIER = {
    id: 1,
    name: 'Gold',
    discount_type: 'percent' as const,
    discount_value: 10,
    min_order_value: 500,
    min_order_units: 5,
  };

  it('flags total-below-min_order_value', () => {
    const result = run(
      makeInput({
        shop: { isPlus: { value: 'false' }, tiersConfig: tiersConfigValue([TIER]) },
        cart: {
          lines: [line({ quantity: 1 })], // 1 × 100 × 0.9 = 90
          buyerIdentity: { purchasingCompany: { company: { metafield: { value: '1' } } } },
        },
      }),
    );
    expect(result.errors.some(e => e.message.includes('Minimum order value'))).toBe(true);
  });

  it('flags units-below-min_order_units', () => {
    const result = run(
      makeInput({
        shop: { isPlus: { value: 'false' }, tiersConfig: tiersConfigValue([TIER]) },
        cart: {
          lines: [line({ quantity: 2 })], // 2 units, threshold 5
          buyerIdentity: { purchasingCompany: { company: { metafield: { value: '1' } } } },
        },
      }),
    );
    expect(result.errors.some(e => e.message.includes('Minimum order units'))).toBe(true);
  });

  it('passes when both thresholds met', () => {
    const result = run(
      makeInput({
        shop: { isPlus: { value: 'false' }, tiersConfig: tiersConfigValue([TIER]) },
        cart: {
          lines: [line({ quantity: 10 })], // 10 × 100 × 0.9 = 900, 10 units
          buyerIdentity: { purchasingCompany: { company: { metafield: { value: '1' } } } },
        },
      }),
    );
    expect(result.errors).toEqual([]);
  });

  it('does not enforce tier minimums when no tier is matched', () => {
    const result = run(
      makeInput({
        shop: { isPlus: { value: 'false' }, tiersConfig: tiersConfigValue([TIER]) },
        cart: {
          lines: [line({ quantity: 1 })],
          buyerIdentity: { purchasingCompany: { company: { metafield: { value: '999' } } } },
        },
      }),
    );
    expect(result.errors).toEqual([]);
  });
});
