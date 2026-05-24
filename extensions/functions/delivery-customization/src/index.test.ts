import { describe, it, expect } from 'vitest';
import { run, type FunctionInput, type DeliveryGroup } from './index.js';

function tiersConfigValue(tiers: unknown[]): { value: string } {
  return { value: JSON.stringify({ version: 1, tiers }) };
}

const STANDARD: DeliveryGroup = {
  id: 'g1',
  deliveryOptions: [
    { handle: 'standard', title: 'Standard shipping', type: 'shipping' },
    { handle: 'express', title: 'Express shipping', type: 'shipping' },
    { handle: 'pickup', title: 'In-store pickup', type: 'pickup' },
  ],
};

function makeInput(overrides: Partial<FunctionInput> = {}): FunctionInput {
  return {
    shop: { isPlus: { value: 'false' }, tiersConfig: null },
    cart: {
      lines: [
        { quantity: 1, cost: { amountPerQuantity: { amount: '100' } } },
      ],
      deliveryGroups: [STANDARD],
      buyerIdentity: null,
    },
    ...overrides,
  };
}

describe('delivery-customization: Plus-mode gate', () => {
  it('returns no operations when shop.isPlus is "true"', () => {
    expect(
      run(
        makeInput({
          shop: {
            isPlus: { value: 'true' },
            tiersConfig: tiersConfigValue([
              { id: 1, name: 'Gold', discount_type: 'none', discount_value: 0, pickup_only: true, free_shipping_threshold: null, flat_shipping_amount: null },
            ]),
          },
          cart: {
            lines: [{ quantity: 1, cost: { amountPerQuantity: { amount: '100' } } }],
            deliveryGroups: [STANDARD],
            buyerIdentity: { purchasingCompany: { company: { metafield: { value: '1' } } } },
          },
        }),
      ),
    ).toEqual({ operations: [] });
  });
});

describe('delivery-customization: pickup_only', () => {
  it('hides every non-pickup option', () => {
    const result = run(
      makeInput({
        shop: {
          isPlus: { value: 'false' },
          tiersConfig: tiersConfigValue([
            { id: 1, name: 'Pickup', discount_type: 'none', discount_value: 0, pickup_only: true, free_shipping_threshold: null, flat_shipping_amount: null },
          ]),
        },
        cart: {
          lines: [{ quantity: 1, cost: { amountPerQuantity: { amount: '100' } } }],
          deliveryGroups: [STANDARD],
          buyerIdentity: { purchasingCompany: { company: { metafield: { value: '1' } } } },
        },
      }),
    );
    expect(result.operations).toEqual([
      { hide: { deliveryOptionHandle: 'standard' } },
      { hide: { deliveryOptionHandle: 'express' } },
    ]);
  });
});

describe('delivery-customization: free shipping threshold', () => {
  const TIER = {
    id: 1,
    name: 'Gold',
    discount_type: 'percent' as const,
    discount_value: 10,
    pickup_only: false,
    free_shipping_threshold: 500,
    flat_shipping_amount: null,
  };

  it('does not rename when subtotal-after-discount is below threshold', () => {
    const result = run(
      makeInput({
        shop: { isPlus: { value: 'false' }, tiersConfig: tiersConfigValue([TIER]) },
        cart: {
          lines: [{ quantity: 1, cost: { amountPerQuantity: { amount: '100' } } }], // 90 after discount
          deliveryGroups: [STANDARD],
          buyerIdentity: { purchasingCompany: { company: { metafield: { value: '1' } } } },
        },
      }),
    );
    expect(result.operations).toEqual([]);
  });

  it('renames non-pickup options to Free shipping when subtotal meets threshold', () => {
    const result = run(
      makeInput({
        shop: { isPlus: { value: 'false' }, tiersConfig: tiersConfigValue([TIER]) },
        cart: {
          lines: [{ quantity: 10, cost: { amountPerQuantity: { amount: '100' } } }], // 900 after discount
          deliveryGroups: [STANDARD],
          buyerIdentity: { purchasingCompany: { company: { metafield: { value: '1' } } } },
        },
      }),
    );
    expect(result.operations).toEqual([
      { rename: { deliveryOptionHandle: 'standard', title: 'Free shipping' } },
      { rename: { deliveryOptionHandle: 'express', title: 'Free shipping' } },
    ]);
  });

  it('threshold excludes tax (we only pass subtotal in)', () => {
    // Implicit — we never compute a post-tax total. Verifying behavior:
    // a cart that crosses the threshold pre-tax triggers free-shipping
    // regardless of any hypothetical tax line. This test asserts that
    // the Function uses our subtotal calculation, not anything cart-tax.
    const result = run(
      makeInput({
        shop: { isPlus: { value: 'false' }, tiersConfig: tiersConfigValue([TIER]) },
        cart: {
          lines: [{ quantity: 6, cost: { amountPerQuantity: { amount: '100' } } }], // 540 after discount
          deliveryGroups: [STANDARD],
          buyerIdentity: { purchasingCompany: { company: { metafield: { value: '1' } } } },
        },
      }),
    );
    expect(result.operations.some(op => 'rename' in op)).toBe(true);
  });
});

describe('delivery-customization: flat rate', () => {
  const FLAT_TIER = {
    id: 2,
    name: 'Trade',
    discount_type: 'none' as const,
    discount_value: 0,
    pickup_only: false,
    free_shipping_threshold: null,
    flat_shipping_amount: 15,
  };

  it('renames non-pickup options to advertise flat rate', () => {
    const result = run(
      makeInput({
        shop: { isPlus: { value: 'false' }, tiersConfig: tiersConfigValue([FLAT_TIER]) },
        cart: {
          lines: [{ quantity: 1, cost: { amountPerQuantity: { amount: '50' } } }],
          deliveryGroups: [STANDARD],
          buyerIdentity: { purchasingCompany: { company: { metafield: { value: '2' } } } },
        },
      }),
    );
    expect(result.operations).toEqual([
      { rename: { deliveryOptionHandle: 'standard', title: 'Flat-rate shipping (15.00)' } },
      { rename: { deliveryOptionHandle: 'express', title: 'Flat-rate shipping (15.00)' } },
    ]);
  });
});

describe('delivery-customization: rates do not leak across tiers', () => {
  it('a different tier than the configured one produces no operations', () => {
    const result = run(
      makeInput({
        shop: {
          isPlus: { value: 'false' },
          tiersConfig: tiersConfigValue([
            { id: 1, name: 'Gold', discount_type: 'none', discount_value: 0, pickup_only: true, free_shipping_threshold: null, flat_shipping_amount: null },
            { id: 2, name: 'Silver', discount_type: 'none', discount_value: 0, pickup_only: false, free_shipping_threshold: null, flat_shipping_amount: null },
          ]),
        },
        cart: {
          lines: [{ quantity: 1, cost: { amountPerQuantity: { amount: '100' } } }],
          deliveryGroups: [STANDARD],
          buyerIdentity: { purchasingCompany: { company: { metafield: { value: '2' } } } }, // tier 2 has no rules
        },
      }),
    );
    // Silver has nothing configured — no operations. Gold's pickup_only must not leak.
    expect(result.operations).toEqual([]);
  });
});
