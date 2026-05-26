// Asserts the post-login reveal SLO from PLAN.md 1B: with a cold cache and
// a realistic tier-context response time, the discounted price must paint
// within 500ms. Targets the fetch path (b2b-price.js:89-96).
//
// We measure DOMContentLoaded → data-tier-applied attribute set on the
// block, across N iterations. The pure JS work is microseconds; the
// budget is essentially network round-trip to /tier-context, which we
// hold to 50ms (representative of an edge-cached App Proxy hit). The 500ms
// ceiling leaves an order-of-magnitude headroom for real merchant traffic.

import { test, expect } from '@playwright/test';
import { fixtureUrl, mockTierContext } from './_helpers.js';

const ITERATIONS = 10;
const NETWORK_DELAY_MS = 50;
const SLO_MS = 500;

test('p95 reveal latency (cache miss) stays under 500ms', async ({ browser }, info) => {
  const samples: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await mockTierContext(
      page,
      { tier: { id: 1, name: 'Silver', discount_type: 'percent', discount_value: 10 }, b2b: true },
      { delayMs: NETWORK_DELAY_MS },
    );

    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        (window as unknown as { __b2bDclAt: number }).__b2bDclAt = performance.now();
      });
    });

    await page.goto(fixtureUrl(info, 'pdp.html'));
    await expect(page.locator('[data-b2b-price-block]')).toHaveAttribute('data-tier-applied', '1');

    const elapsed = await page.evaluate(() => {
      const dcl = (window as unknown as { __b2bDclAt: number }).__b2bDclAt ?? 0;
      return performance.now() - dcl;
    });
    samples.push(elapsed);
    await ctx.close();
  }

  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95) - 1] ?? samples[samples.length - 1];
  // eslint-disable-next-line no-console
  console.log(`[${info.project.name}] reveal latency p95 = ${p95.toFixed(1)}ms (samples: ${samples.map((s) => s.toFixed(0)).join(', ')})`);
  expect(p95).toBeLessThan(SLO_MS);
});
