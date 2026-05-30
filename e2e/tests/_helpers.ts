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
// Overrides window.fetch via addInitScript instead of page.route because
// fetch() from a file:// origin is blocked by Chromium ("URL scheme 'file'
// is not supported"), so network-layer interception never sees the request.
// `delayMs` simulates merchant network latency for the reveal-latency suite.
export async function mockTierContext(
  page: Page,
  body: { tier: { id: number; name: string; discount_type: 'percent' | 'amount'; discount_value: number } | null; b2b: boolean; company_id?: string },
  opts: { delayMs?: number } = {},
) {
  await page.addInitScript(
    ({ body, delayMs }) => {
      const orig = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        if (url.includes('/tier-context')) {
          const make = () =>
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          return delayMs > 0
            ? new Promise<Response>((r) => setTimeout(() => r(make()), delayMs))
            : Promise.resolve(make());
        }
        return orig(input, init);
      }) as typeof fetch;
    },
    { body, delayMs: opts.delayMs ?? 0 },
  );
}

// Captures b2b-price.js's `window.location.replace('/collections/all')` call
// (b2b-price.js:122-124) by observing the navigation it triggers. We can't
// monkey-patch window.location.replace directly — Chromium marks every Location
// property as non-configurable / non-writable, so Object.defineProperty throws
// "Cannot redefine property: replace". Instead we route any request to
// /collections/all to a tiny fulfilled page (so the test doesn't actually
// navigate to a 404) and record the path via framenavigated.
export async function installLocationReplaceProbe(page: Page): Promise<void> {
  const calls: string[] = [];
  const state = { initial: false };
  (page as unknown as { __b2bReplaceCalls: string[] }).__b2bReplaceCalls = calls;

  await page.route('**/collections/all*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
    });
  });

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    if (!state.initial) {
      state.initial = true;
      return;
    }
    const url = frame.url();
    try {
      const u = new URL(url);
      calls.push(u.pathname + u.search);
    } catch {
      calls.push(url);
    }
  });
}

export async function getReplaceCalls(page: Page): Promise<string[]> {
  const local = (page as unknown as { __b2bReplaceCalls?: string[] }).__b2bReplaceCalls;
  return local ? [...local] : [];
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
