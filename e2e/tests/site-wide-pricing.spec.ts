// Phase 1K — site-wide tier-price overlay (b2b-price.js handleController +
// overlayNode + MutationObserver). Each theme fixture exposes three collection
// cards priced $50 / $100 / $25 and a [data-b2b-price-controller] carrying the
// theme's resolved price selector. The overlay layers the tier delta on top of
// the rendered (catalog) price the same way the cart-transform Function does,
// so these expected values also match checkout.
//
// Hermetic: tier context is seeded into localStorage (cache-hit path) so no
// network is needed. Runs across Dawn / Horizon / Impulse / Prestige.

import { test, expect } from '@playwright/test';
import { fixtureUrl, seedTierCache } from './_helpers.js';

const PERCENT_TIER = {
  tier: { id: 7, name: 'Gold', discount_type: 'percent' as const, discount_value: 20 },
  b2b: true,
};
const AMOUNT_TIER = {
  tier: { id: 8, name: 'Flat', discount_type: 'amount' as const, discount_value: 10 },
  b2b: true,
};

test('percent tier overlays every collection card price', async ({ page }, info) => {
  await seedTierCache(page, PERCENT_TIER);
  // Cache hit must not fetch; fail loudly if it does.
  await page.route('**/tier-context', (route) =>
    route.fulfill({ status: 500, body: 'cache hit: should not fetch' }),
  );

  await page.goto(fixtureUrl(info, 'collection.html'), { waitUntil: 'domcontentloaded' });

  const tierPrices = page.locator('[data-b2b-tier-price]');
  await expect(tierPrices).toHaveCount(3);
  await expect(tierPrices.nth(0)).toHaveText('$40.00'); // 50 − 20%
  await expect(tierPrices.nth(1)).toHaveText('$80.00'); // 100 − 20%
  await expect(tierPrices.nth(2)).toHaveText('$20.00'); // 25 − 20%
});

test('fixed-amount tier overlays every collection card price', async ({ page }, info) => {
  await seedTierCache(page, AMOUNT_TIER);

  await page.goto(fixtureUrl(info, 'collection.html'), { waitUntil: 'domcontentloaded' });

  const tierPrices = page.locator('[data-b2b-tier-price]');
  await expect(tierPrices).toHaveCount(3);
  await expect(tierPrices.nth(0)).toHaveText('$40.00'); // 50 − $10
  await expect(tierPrices.nth(1)).toHaveText('$90.00'); // 100 − $10
  await expect(tierPrices.nth(2)).toHaveText('$15.00'); // 25 − $10
});

test('no tier in context (e.g. Plus or non-tiered buyer) leaves prices untouched', async ({
  page,
}, info) => {
  // tier-context returns no tier on Plus shops; the overlay must no-op so it
  // never shows a discount checkout won't honour.
  await seedTierCache(page, { tier: null, b2b: true });

  await page.goto(fixtureUrl(info, 'collection.html'), { waitUntil: 'domcontentloaded' });

  await expect(page.locator('[data-b2b-tier-price]')).toHaveCount(0);
});

test('savings badge renders alongside the discounted price', async ({ page }, info) => {
  await seedTierCache(page, PERCENT_TIER);

  await page.goto(fixtureUrl(info, 'collection.html'), { waitUntil: 'domcontentloaded' });

  await expect(page.locator('[data-b2b-tier-savings]').first()).toContainText('Save $10.00');
});

test('MutationObserver overlays AJAX-injected prices (cart drawer) without double-applying', async ({
  page,
}, info) => {
  await seedTierCache(page, PERCENT_TIER);

  await page.goto(fixtureUrl(info, 'collection.html'), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-b2b-tier-price]')).toHaveCount(3);

  // Mount a price after first paint, like a cart drawer opening. The injected
  // <product-price class="price"> matches every theme's controller selector.
  await page.evaluate(() => {
    const drawer = document.createElement('div');
    drawer.className = 'cart-drawer';
    drawer.innerHTML = '<product-price class="price">$50.00</product-price>';
    document.body.appendChild(drawer);
  });

  await expect(page.locator('.cart-drawer [data-b2b-tier-price]')).toHaveText('$40.00');
  // The three original nodes are not re-processed: 3 + 1 = 4, never more.
  await expect(page.locator('[data-b2b-tier-price]')).toHaveCount(4);
});
