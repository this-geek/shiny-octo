import { describe, it, expect } from 'vitest';
import { calcCartDiscount, type CartLine, type Tier } from '@b2b/shared';
import { run, type FunctionInput } from './index.js';

function tiersConfigValue(tiers: Array<{
  id: number;
  name: string;
  discount_type: 'percent' | 'amount' | 'none';
  discount_value: number;
}>): { value: string } {
  return { value: JSON.stringify({ version: 1, tiers }) };
}

function makeInput(overrides: Partial<FunctionInput> = {}): FunctionInput {
  return {
    shop: {
      isPlus: { value: 'false' },
      tiersConfig: tiersConfigValue([
        { id: 1, name: 'Gold', discount_type: 'percent', discount_value: 10 },
      ]),
    },
    cart: {
      lines: [
        {
          id: 'gid://shopify/CartLine/1',
          quantity: 2,
          cost: { amountPerQuantity: { amount: '100.00' } },
        },
      ],
      buyerIdentity: {
        purchasingCompany: {
          company: { metafield: { value: '1' } },
        },
      },
    },
    ...overrides,
  };
}

describe('cart-transform: Plus-mode gate', () => {
  it('returns no operations when shop.isPlus is "true"', () => {
    const result = run(makeInput({
      shop: {
        isPlus: { value: 'true' },
        tiersConfig: tiersConfigValue([
          { id: 1, name: 'Gold', discount_type: 'percent', discount_value: 10 },
        ]),
      },
    }));
    expect(result.operations).toEqual([]);
  });
});

describe('cart-transform: no-op conditions', () => {
  it('no operations when tiers_config metafield is missing', () => {
    const result = run(makeInput({
      shop: { isPlus: { value: 'false' }, tiersConfig: null },
    }));
    expect(result.operations).toEqual([]);
  });

  it('no operations when buyer has no purchasingCompany', () => {
    const result = run(makeInput({
      cart: {
        lines: [{
          id: 'l1',
          quantity: 1,
          cost: { amountPerQuantity: { amount: '50.00' } },
        }],
        buyerIdentity: null,
      },
    }));
    expect(result.operations).toEqual([]);
  });

  it('no operations when company tier_id metafield is "0" (no tier)', () => {
    const result = run(makeInput({
      cart: {
        lines: [{
          id: 'l1',
          quantity: 1,
          cost: { amountPerQuantity: { amount: '50.00' } },
        }],
        buyerIdentity: {
          purchasingCompany: {
            company: { metafield: { value: '0' } },
          },
        },
      },
    }));
    expect(result.operations).toEqual([]);
  });

  it('no operations when tier id does not exist in tiers_config', () => {
    const result = run(makeInput({
      cart: {
        lines: [{
          id: 'l1',
          quantity: 1,
          cost: { amountPerQuantity: { amount: '50.00' } },
        }],
        buyerIdentity: {
          purchasingCompany: {
            company: { metafield: { value: '999' } },
          },
        },
      },
    }));
    expect(result.operations).toEqual([]);
  });

  it('no operations when matched tier has discount_type none', () => {
    const result = run(makeInput({
      shop: {
        isPlus: { value: 'false' },
        tiersConfig: tiersConfigValue([
          { id: 1, name: 'Trade', discount_type: 'none', discount_value: 0 },
        ]),
      },
    }));
    expect(result.operations).toEqual([]);
  });
});

describe('cart-transform: price overrides', () => {
  it('emits a fixedPricePerUnit override per line for percent discount', () => {
    const result = run(makeInput()); // 10% off $100
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toEqual({
      update: {
        cartLineId: 'gid://shopify/CartLine/1',
        price: {
          adjustment: {
            fixedPricePerUnit: { amount: '90.00' },
          },
        },
      },
    });
  });

  it('applies amount discount per unit, clamped to 0', () => {
    const result = run(makeInput({
      shop: {
        isPlus: { value: 'false' },
        tiersConfig: tiersConfigValue([
          { id: 1, name: 'Trade', discount_type: 'amount', discount_value: 200 },
        ]),
      },
    }));
    expect(result.operations[0].update.price.adjustment.fixedPricePerUnit.amount).toBe('0.00');
  });

  it('skips lines with zero or negative price', () => {
    const result = run(makeInput({
      cart: {
        lines: [
          { id: 'l1', quantity: 1, cost: { amountPerQuantity: { amount: '0' } } },
          { id: 'l2', quantity: 1, cost: { amountPerQuantity: { amount: '100' } } },
        ],
        buyerIdentity: {
          purchasingCompany: { company: { metafield: { value: '1' } } },
        },
      },
    }));
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].update.cartLineId).toBe('l2');
  });
});

describe('cart-transform: parity with @b2b/shared calcCartDiscount', () => {
  it('per-line override total matches shared calcCartDiscount total', () => {
    const tier = { id: 1, name: 'Gold', discount_type: 'percent' as const, discount_value: 10 };
    const sharedTier: Tier = {
      ...tier,
      shop_id: 1,
      min_order_value: null,
      min_order_units: null,
      free_shipping_threshold: null,
      flat_shipping_amount: null,
      pickup_only: false,
      priority: 0,
      deleted_at: null,
    };
    // Prices chosen so per-unit discount lands on whole cents — that's
    // the strict identity case. The Function rounds per-unit to 2 dp
    // before multiplying by quantity (because that's what Shopify
    // requires for fixedPricePerUnit), so prices like 12.34 produce a
    // sub-cent drift between Function and shared. That's expected
    // rounding behavior, not a parity violation.
    const lines: CartLine[] = [
      { variant_id: 'v1', price: 100, quantity: 2, eligible_for_tier: true },
      { variant_id: 'v2', price: 250, quantity: 1, eligible_for_tier: true },
      { variant_id: 'v3', price: 12.5, quantity: 5, eligible_for_tier: true },
    ];

    const sharedTotals = calcCartDiscount(lines, sharedTier);

    const input = makeInput({
      shop: { isPlus: { value: 'false' }, tiersConfig: tiersConfigValue([tier]) },
      cart: {
        lines: lines.map((l, i) => ({
          id: `gid://line/${i}`,
          quantity: l.quantity,
          cost: { amountPerQuantity: { amount: l.price.toFixed(2) } },
        })),
        buyerIdentity: {
          purchasingCompany: { company: { metafield: { value: '1' } } },
        },
      },
    });
    const result = run(input);

    const functionTotal = result.operations.reduce((sum, op, i) => {
      const overridePrice = Number.parseFloat(
        op.update.price.adjustment.fixedPricePerUnit.amount,
      );
      return sum + overridePrice * lines[i].quantity;
    }, 0);

    expect(functionTotal).toBeCloseTo(sharedTotals.totalAfter, 2);
  });
});
