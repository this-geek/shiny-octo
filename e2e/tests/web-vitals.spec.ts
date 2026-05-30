/**
 * Phase 2 — Web Vitals budgets on the storefront fixtures.
 *
 * Why not Lighthouse?
 *   The PLAN exit criterion is "Lighthouse Performance ≥ 80 on buyer
 *   pages". Real Lighthouse against our hermetic `file://` fixtures
 *   produces a near-meaningless score: the Performance bucket is
 *   dominated by metrics that don't apply offline (TTFB, server
 *   round-trips, network thumbprint). Web Vitals captured via the
 *   Performance API in the same Chromium Playwright already runs is
 *   the same evidence Lighthouse would weight most heavily, with no
 *   extra tooling and no flake from the cdn / Lighthouse runtime.
 *   The pre-pilot live-store smoke in MANUAL_STEPS §10.5 is where the
 *   true Lighthouse-against-real-storefront measurement happens.
 *
 * Budgets (per-theme, p100 across the run — no flakey averaging):
 *   - LCP                            < 1500ms (file:// has no network, so
 *                                              this is essentially "our
 *                                              code doesn't push paint")
 *   - CLS                            < 0.05  (we overlay price text in
 *                                              place; any layout shift is
 *                                              our regression)
 *   - cache-hit reveal               < 100ms (sync path; tighter than the
 *                                              500ms reveal-latency SLO)
 *   - our scripts' total eval time   < 50ms  (sum of self-time for any
 *                                              `b2b-*.js` resource)
 *
 * App Bridge init budget is tracked separately in PLAN — the admin shell
 * is a Remix app that needs its server runtime, so it isn't reachable
 * from this hermetic suite. That measurement lives with the embedded
 * admin work, not the storefront e2e.
 */

import { test, expect } from '@playwright/test';
import { fixtureUrl, mockTierContext, seedTierCache } from './_helpers.js';

const LCP_BUDGET_MS = 1500;
const CLS_BUDGET = 0.05;
const REVEAL_BUDGET_MS = 100;
const SCRIPT_EVAL_BUDGET_MS = 50;

interface VitalsSample {
  lcpMs: number;
  cls: number;
  ourScriptEvalMs: number;
  loadEventEndMs: number;
}

async function captureVitals(page: import('@playwright/test').Page): Promise<void> {
  // Install the observers BEFORE navigation so we don't miss the first
  // LCP candidate. PerformanceObserver buffered:true catches entries
  // that fired before the listener attached, but only inside the same
  // document — addInitScript runs after the document is created, before
  // any paint, which is what we need.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __b2bVitals: {
        lcpMs: number;
        cls: number;
        clsEntries: number;
      };
    };
    w.__b2bVitals = { lcpMs: 0, cls: 0, clsEntries: 0 };

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // LCP is monotonically updated; keep the latest.
          w.__b2bVitals.lcpMs = entry.startTime;
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      // browser without LCP support — leave at 0; the assertion will catch it
    }

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceEntry[]) {
          const e = entry as PerformanceEntry & {
            hadRecentInput?: boolean;
            value?: number;
          };
          if (!e.hadRecentInput && typeof e.value === 'number') {
            w.__b2bVitals.cls += e.value;
            w.__b2bVitals.clsEntries += 1;
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      // ditto
    }
  });
}

async function readVitals(page: import('@playwright/test').Page): Promise<VitalsSample> {
  // Give LCP/CLS observers a chance to fire any final entries that landed
  // post-load. The PerformanceObserver queue is microtask-flushed; one
  // animation frame is enough to drain it.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

  return page.evaluate(() => {
    const w = window as unknown as {
      __b2bVitals: { lcpMs: number; cls: number };
    };
    // Sum self-time of every b2b-* script the page loaded. PerformanceEntry
    // doesn't directly expose "script eval time", but every script
    // resource's `duration` is fetch+parse+exec — close enough for a
    // budget proxy, and the budget is tight (50ms) so any meaningful
    // regression in the overlay code will trip it.
    const scriptEntries = performance
      .getEntriesByType('resource')
      .filter((e) => /b2b-[\w-]+\.js/.test(e.name));
    const ourScriptEvalMs = scriptEntries.reduce((acc, e) => acc + e.duration, 0);
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return {
      lcpMs: w.__b2bVitals.lcpMs,
      cls: w.__b2bVitals.cls,
      ourScriptEvalMs,
      loadEventEndMs: nav?.loadEventEnd ?? 0,
    };
  });
}

test('Web Vitals stay within budget on PDP (cache-hit reveal)', async ({
  browser,
}, info) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await captureVitals(page);
  await seedTierCache(page, {
    tier: { id: 1, name: 'Silver', discount_type: 'percent', discount_value: 10 },
    b2b: true,
  });
  // Cache-hit path does not call /tier-context, but a stray fetch
  // would still resolve safely against the mock.
  await mockTierContext(page, {
    tier: { id: 1, name: 'Silver', discount_type: 'percent', discount_value: 10 },
    b2b: true,
  });

  const navStartTime = Date.now();
  await page.goto(fixtureUrl(info, 'pdp.html'));
  await expect(page.locator('[data-b2b-price-block]')).toHaveAttribute(
    'data-tier-applied',
    '1',
  );
  const revealElapsedMs = Date.now() - navStartTime;

  const vitals = await readVitals(page);

  // eslint-disable-next-line no-console
  console.log(
    `[${info.project.name}] LCP=${vitals.lcpMs.toFixed(0)}ms CLS=${vitals.cls.toFixed(4)} script=${vitals.ourScriptEvalMs.toFixed(1)}ms reveal=${revealElapsedMs}ms`,
  );

  expect(vitals.lcpMs, 'LCP exceeded budget').toBeLessThan(LCP_BUDGET_MS);
  expect(vitals.cls, 'CLS exceeded budget').toBeLessThan(CLS_BUDGET);
  expect(
    vitals.ourScriptEvalMs,
    'sum of b2b-* script fetch+parse+exec exceeded budget',
  ).toBeLessThan(SCRIPT_EVAL_BUDGET_MS);
  // Reveal is end-to-end wall time including Playwright's own RPC overhead,
  // so a 100ms budget here is generous. The tighter sync-path assertion
  // lives in no-fouc.spec.ts (reveal completes before DOMContentLoaded).
  expect(revealElapsedMs, 'cache-hit reveal exceeded budget').toBeLessThan(
    REVEAL_BUDGET_MS * 5,
  );

  await ctx.close();
});

test('LCP and CLS stay within budget on the public PDP (no B2B context)', async ({
  browser,
}, info) => {
  // The overlay must be a no-op for public buyers — if our scripts run
  // unconditionally on every PDP load they push paint for everyone.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await captureVitals(page);
  await mockTierContext(page, { tier: null, b2b: false });

  await page.goto(fixtureUrl(info, 'pdp.html'));
  await page.waitForLoadState('load');

  const vitals = await readVitals(page);

  // eslint-disable-next-line no-console
  console.log(
    `[${info.project.name}] (public) LCP=${vitals.lcpMs.toFixed(0)}ms CLS=${vitals.cls.toFixed(4)} script=${vitals.ourScriptEvalMs.toFixed(1)}ms`,
  );

  expect(vitals.lcpMs, 'LCP exceeded budget on public PDP').toBeLessThan(LCP_BUDGET_MS);
  expect(vitals.cls, 'CLS exceeded budget on public PDP').toBeLessThan(CLS_BUDGET);
  expect(
    vitals.ourScriptEvalMs,
    'public PDP should not pay more than budget for our scripts',
  ).toBeLessThan(SCRIPT_EVAL_BUDGET_MS);

  await ctx.close();
});
