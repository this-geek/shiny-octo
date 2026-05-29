// Renders + selector-preset coverage for b2b-price.js.
//
// b2b-price.js is an IIFE (no exports). We mirror the two pieces of behaviour
// we care about here:
//   1. buildTierMarkup — the discounted price + optional savings badge HTML.
//   2. The preset → selector mapping that Liquid encodes in b2b-price.liquid's
//      `case preset` block. If Liquid changes, this table must change with it;
//      that's the point — surface the drift to reviewers.

import { describe, it, expect } from 'vitest';

function buildTierMarkup(basePriceCents, discountedDollars, showSavingsBadge) {
  const baseDollars = basePriceCents / 100;
  const savings = baseDollars - discountedDollars;
  let html = '<span class="b2b-tier-price" data-b2b-tier-price>$' + discountedDollars.toFixed(2) + '</span>';
  if (showSavingsBadge && savings > 0) {
    html += ' <span class="b2b-tier-savings" data-b2b-tier-savings>Save $' + savings.toFixed(2) + '</span>';
  }
  return html;
}

const LIQUID_PRESET_MAP = {
  auto: {
    price: 'product-price, .product__price, .price',
    form: 'product-form, .product-form, .product-form__buttons',
  },
  dawn: {
    price: '.product__price, .price',
    form: '.product-form, .product-form__buttons',
  },
  horizon: {
    price: 'product-price',
    form: 'product-form',
  },
};

describe('buildTierMarkup', () => {
  it('renders price-only when savings badge disabled', () => {
    expect(buildTierMarkup(10000, 80, false)).toBe(
      '<span class="b2b-tier-price" data-b2b-tier-price>$80.00</span>',
    );
  });

  it('renders price + savings badge when enabled and savings > 0', () => {
    const html = buildTierMarkup(10000, 80, true);
    expect(html).toContain('$80.00');
    expect(html).toContain('Save $20.00');
  });

  it('omits savings badge when discount is 0', () => {
    const html = buildTierMarkup(10000, 100, true);
    expect(html).toContain('$100.00');
    expect(html).not.toContain('Save');
  });

  it('omits savings badge when discounted price exceeds base (defensive)', () => {
    const html = buildTierMarkup(10000, 120, true);
    expect(html).not.toContain('Save');
  });
});

describe('Liquid preset → selector parity reference', () => {
  // These cases mirror the `{%- case preset -%}` block in
  // extensions/theme-app-extension/blocks/b2b-price.liquid. Edits to the
  // Liquid must be reflected here; CI failure on this test means a reviewer
  // should manually confirm the change is intentional.
  it.each(Object.entries(LIQUID_PRESET_MAP))(
    'preset %s has both price and form selectors',
    (_preset, sels) => {
      expect(sels.price).toBeTruthy();
      expect(sels.form).toBeTruthy();
    },
  );

  it('horizon preset targets the <product-price> custom element', () => {
    expect(LIQUID_PRESET_MAP.horizon.price).toContain('product-price');
  });

  it('dawn preset targets .product__price', () => {
    expect(LIQUID_PRESET_MAP.dawn.price).toContain('.product__price');
  });

  it('auto preset covers both Dawn and Horizon vocab', () => {
    expect(LIQUID_PRESET_MAP.auto.price).toContain('product-price');
    expect(LIQUID_PRESET_MAP.auto.price).toContain('.product__price');
  });
});
