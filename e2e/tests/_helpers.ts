import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import type { Page, TestInfo } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(here, '..', 'fixtures');

export function themeOf(info: TestInfo): string {
  const theme = (info.project.metadata as { theme?: string } | undefined)?.theme;
  if (!theme) throw new Error(`project ${info.project.name} missing theme metadata`);
  return theme;
}

export function fixtureUrl(
  info: TestInfo,
  file: 'pdp.html' | 'pdp.b2b-only.html' | 'collection.html',
): string {
  return pathToFileURL(resolve(fixturesRoot, themeOf(info), file)).href;
}

// Mocks the /tier-context App Proxy endpoint per b2b-price.js:43-50.
// `delayMs` simulates merchant network latency for the reveal-latency suite.
export async function mockTierContext(
  page: Page,
  body: { tier: { id: number; name: string; discount_type: 'percent' | 'amount'; discount_value: number } | null; b2b: boolean; company_id?: string },
  opts: { delayMs?: number } = {},
) {
  await page.route('**/tier-context', async (route) => {
    if (opts.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

// Stubs window.location.replace before any page script runs (b2b-price.js uses
// this for the direct-URL guard branch at b2b-price.js:67-71). Returns a
// promise that resolves with the URL the script tried to navigate to.
export async function installLocationReplaceProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __b2bReplaceCalls: string[] }).__b2bReplaceCalls = [];
    const real = window.location.replace.bind(window.location);
    Object.defineProperty(window.location, 'replace', {
      configurable: true,
      writable: true,
      value: (url: string) => {
        (window as unknown as { __b2bReplaceCalls: string[] }).__b2bReplaceCalls.push(String(url));
        void real;
      },
    });
  });
}

export async function getReplaceCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __b2bReplaceCalls: string[] }).__b2bReplaceCalls);
}

export async function seedTierCache(
  page: Page,
  payload: { tier: { id: number; name: string; discount_type: 'percent' | 'amount'; discount_value: number } | null; b2b: boolean },
  ttlMs = 5 * 60 * 1000,
) {
  await page.addInitScript(
    ({ payload, ttlMs }) => {
      try {
        window.localStorage.setItem(
          'b2b_tier',
          JSON.stringify({ ...payload, expires_at: Date.now() + ttlMs }),
        );
      } catch {
        // best-effort
      }
    },
    { payload, ttlMs },
  );
}
