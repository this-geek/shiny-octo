// Sanity check that each theme fixture exposes the selectors the Liquid
// defence-in-depth hide rule targets (b2b-price.liquid:32-34). If a future
// theme refactor changes a price selector, this test fails before users
// notice price leakage.

import { test, expect } from '@playwright/test';
import { fixtureUrl } from './_helpers.js';

const HIDE_SELECTORS = ['.product-form', '.product__price', '.price', '.product-form__buttons'];

test('theme fixture exposes the b2b-price block container', async ({ page }, info) => {
  await page.goto(fixtureUrl(info, 'pdp.html'));
  await expect(page.locator('[data-b2b-price-block]')).toHaveCount(1);
});

for (const sel of HIDE_SELECTORS) {
  test(`theme fixture contains hide-rule selector ${sel}`, async ({ page }, info) => {
    await page.goto(fixtureUrl(info, 'pdp.html'));
    await expect(page.locator(sel).first()).toBeAttached();
  });
}

test('b2b-only fixture renders the inline hide style', async ({ page }, info) => {
  await page.goto(fixtureUrl(info, 'pdp.b2b-only.html'));
  // After the Liquid <style> rule applies, the price element exists but is
  // visually hidden via display:none.
  const priceVisible = await page.locator('.price').first().isVisible();
  expect(priceVisible).toBe(false);
});
