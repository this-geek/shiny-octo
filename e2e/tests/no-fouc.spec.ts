// Asserts the cache-hit reveal path (b2b-price.js:84-87) renders the
// discounted price synchronously inside the deferred script's execution —
// before DOMContentLoaded, before paint. If this regresses, B2B buyers
// briefly see the public price on every PDP load.
//
// The script's v2 render writes "Your price: …" into a sibling
// [data-b2b-tier-block] next to the theme's price container (per
// renderTierPrice in b2b-price.js), so that's the element we query.

import { test, expect } from '@playwright/test';
import { fixtureUrl, seedTierCache, mockTierContext } from './_helpers.js';

test('cache-hit reveal happens before DOMContentLoaded fires', async ({ page }, info) => {
  await seedTierCache(page, {
    tier: { id: 7, name: 'Gold', discount_type: 'percent', discount_value: 20 },
    b2b: true,
  });
  // Tier-context must not be fetched on cache hit; fail loudly if it is.
  await page.route('**/tier-context', (route) => route.fulfill({ status: 500, body: 'should not be called' }));

  // Record the tier-block's textContent at the exact moment DOMContentLoaded
  // fires, BEFORE Playwright observes it. This proves no FOUC window: the
  // script populated the discounted price before the browser could paint.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const block = document.querySelector('[data-b2b-tier-block]');
      (window as unknown as { __b2bDomTextAtDcl: string }).__b2bDomTextAtDcl = block?.textContent ?? '';
    });
  });

  await page.goto(fixtureUrl(info, 'pdp.html'), { waitUntil: 'domcontentloaded' });

  const textAtDcl = await page.evaluate(
    () => (window as unknown as { __b2bDomTextAtDcl: string }).__b2bDomTextAtDcl,
  );
  // base 4999¢ × (1 - 0.20) = 3999.2¢ → $39.99; savings = 49.99 − 39.99 = $10.00
  expect(textAtDcl).toBe('Your price: $39.99 Save $10.00');
});

test('cache miss does NOT race ahead of DOMContentLoaded (control)', async ({ page }, info) => {
  // No cache; mock with a deliberate delay so the fetch resolves AFTER DCL.
  await mockTierContext(
    page,
    { tier: { id: 1, name: 'Silver', discount_type: 'percent', discount_value: 10 }, b2b: true },
    { delayMs: 100 },
  );

  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const block = document.querySelector('[data-b2b-tier-block]');
      (window as unknown as { __b2bDomTextAtDcl: string | null }).__b2bDomTextAtDcl =
        block ? block.textContent ?? '' : null;
    });
  });

  await page.goto(fixtureUrl(info, 'pdp.html'), { waitUntil: 'domcontentloaded' });

  const textAtDcl = await page.evaluate(
    () => (window as unknown as { __b2bDomTextAtDcl: string | null }).__b2bDomTextAtDcl,
  );
  // The non-cached path renders after the fetch resolves; at DCL the
  // tier-block has not been inserted yet. This confirms the FOUC assertion
  // above is actually load-bearing.
  expect(textAtDcl).toBeNull();

  // Eventually the discounted price renders. base 4999¢ × (1 − 0.10) = 4499.1¢
  // → $44.99; savings = 49.99 − 44.99 = $5.00.
  await expect(page.locator('[data-b2b-tier-block]')).toHaveText('Your price: $44.99 Save $5.00');
});
