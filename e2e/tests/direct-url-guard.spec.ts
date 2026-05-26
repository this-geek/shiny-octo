// Asserts the storefront block's defence-in-depth guard: when the product
// carries b2b.b2b_only=true and the visitor is not B2B, b2b-price.js calls
// window.location.replace('/collections/all') (b2b-price.js:67-71). This
// pairs with the template-level 404 guard merchants paste per
// MANUAL_STEPS.md §10.2; we only test the client-side half here.

import { test, expect } from '@playwright/test';
import { fixtureUrl, mockTierContext, installLocationReplaceProbe, getReplaceCalls } from './_helpers.js';

test('non-B2B visitor on b2b_only product gets redirected away', async ({ page }, info) => {
  await installLocationReplaceProbe(page);
  await mockTierContext(page, { tier: null, b2b: false });

  await page.goto(fixtureUrl(info, 'pdp.b2b-only.html'));

  // init() runs at DOMContentLoaded; fetch is awaited before the redirect.
  // Wait until the script has had a tick to call replace().
  await expect.poll(async () => (await getReplaceCalls(page)).length).toBeGreaterThan(0);

  const calls = await getReplaceCalls(page);
  expect(calls).toEqual(['/collections/all']);
});

test('approved B2B visitor on b2b_only product stays on page', async ({ page }, info) => {
  await installLocationReplaceProbe(page);
  await mockTierContext(page, {
    tier: { id: 1, name: 'Silver', discount_type: 'percent', discount_value: 10 },
    b2b: true,
    company_id: 'gid://shopify/Company/1',
  });

  await page.goto(fixtureUrl(info, 'pdp.b2b-only.html'));
  await expect(page.locator('[data-b2b-price-block]')).toHaveAttribute('data-tier-applied', '1');

  const calls = await getReplaceCalls(page);
  expect(calls).toEqual([]);
});
