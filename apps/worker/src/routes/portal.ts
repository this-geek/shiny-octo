import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { resolveBuyerByCustomerId, type BuyerCtx } from '../lib/buyer-context.js';
import { hashIdAsync, log } from '../lib/logger.js';
import {
  buildAssetListResponse,
  buildAssetDownloadResponse,
  checkAssetDownloadAccess,
} from '../lib/asset-serve.js';
import { buildCompanyProfile } from '../lib/company-profile.js';
import { dismissTour, hasDismissedTour } from '../lib/tour-state.js';
import { APP_JS } from './portal-assets/app-js.js';
import { APP_CSS } from './portal-assets/app-css.js';

/**
 * Buyer-facing dealer asset portal, rendered as a Worker-hosted HTML app
 * reached via Shopify App Proxy at <shop>.myshopify.com/apps/b2b/portal.
 *
 * Auth: every hit is HMAC-signed by Shopify and verified by the parent
 * appProxyRouter middleware before we get here. The signed query carries
 * `shop` and `logged_in_customer_id`, which we use to resolve the buyer's
 * Company context. No session cookie — each XHR through the proxy is
 * re-signed by Shopify, so HMAC is the auth.
 *
 * Subsequent steps will add /portal/api/* routes that return JSON for the
 * SPA to consume. This file currently ships the entry handler + the
 * HTML shell.
 */
export const portalRouter = new Hono<{ Bindings: Env }>();

const COMMON_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'private, no-store',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'self' https://*.myshopify.com https://*.shopify.com",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP,
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loginRequiredPage(shopDomain: string): string {
  const loginUrl = `https://${escapeHtml(shopDomain)}/account/login?return_url=%2Fapps%2Fb2b%2Fportal`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dealer portal — sign in required</title>
</head>
<body>
<main>
<h1>Sign in to access the dealer portal</h1>
<p>Please <a href="${loginUrl}">sign in to your account</a> to view dealer assets and your company profile.</p>
</main>
</body>
</html>`;
}

function notWholesalePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dealer portal</title>
</head>
<body>
<main>
<h1>Dealer portal is not enabled for this account</h1>
<p>This area is reserved for approved wholesale buyers. If you believe you should have access, please contact the store.</p>
</main>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dealer portal — temporarily unavailable</title>
</head>
<body>
<main>
<h1>The dealer portal is temporarily unavailable</h1>
<p>${escapeHtml(message)}</p>
<p>Please try again in a few minutes.</p>
</main>
</body>
</html>`;
}

interface BootPayload {
  shop_domain: string;
  company_id: string | null;
  tier_id: number | null;
  proxy_base: string;
}

function shellPage(boot: BootPayload): string {
  const bootJson = JSON.stringify(boot)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const cssHref = `${boot.proxy_base}/static/app.css`;
  const jsSrc = `${boot.proxy_base}/static/app.js`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dealer portal</title>
<link rel="stylesheet" href="${escapeHtml(cssHref)}">
</head>
<body>
<main id="b2b-portal-root">
<h1>Dealer portal</h1>
<p>Loading…</p>
</main>
<script id="b2b-portal-boot" type="application/json">${bootJson}</script>
<script src="${escapeHtml(jsSrc)}" defer></script>
</body>
</html>`;
}

function deriveProxyBase(c: Context<{ Bindings: Env }>): string {
  const pathPrefix = c.req.query('path_prefix');
  if (pathPrefix && pathPrefix.startsWith('/')) {
    return `${pathPrefix.replace(/\/+$/, '')}/portal`;
  }
  return '/apps/b2b/portal';
}

type ProxyBuyerResult =
  | { ok: true; buyer: BuyerCtx }
  | { ok: false; response: Response };

async function resolveBuyerFromProxyQuery(
  c: Context<{ Bindings: Env }>,
): Promise<ProxyBuyerResult> {
  const shopDomain = c.req.query('shop');
  const customerId = c.req.query('logged_in_customer_id');
  if (!shopDomain) {
    return { ok: false, response: c.json({ error: 'missing shop' }, 400) };
  }
  if (!customerId) {
    return { ok: false, response: c.json({ error: 'login required' }, 401) };
  }
  const r = await resolveBuyerByCustomerId(c.env, shopDomain, customerId);
  if (!r.ok) {
    return {
      ok: false,
      response: c.json({ error: r.error }, r.status as 400 | 401 | 404 | 502),
    };
  }
  return { ok: true, buyer: r.buyer };
}

portalRouter.get('/api/assets/list', async c => {
  const r = await resolveBuyerFromProxyQuery(c);
  if (!r.ok) return r.response;
  const body = await buildAssetListResponse(c.env, r.buyer);
  return c.json(body);
});

portalRouter.get('/api/profile', async c => {
  try {
    const r = await resolveBuyerFromProxyQuery(c);
    if (!r.ok) return r.response;
    const profile = await buildCompanyProfile(c.env, r.buyer);
    return c.json(profile);
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    log('error', 'portal: /api/profile failed', {
      shop: c.req.query('shop') ?? null,
      error: message,
      stack: (err as Error)?.stack ?? null,
    });
    return c.json({ error: message }, 502);
  }
});

portalRouter.get('/api/tour-status', async c => {
  const r = await resolveBuyerFromProxyQuery(c);
  if (!r.ok) return r.response;
  const dismissed = await hasDismissedTour(
    c.env.KV_SESSIONS,
    r.buyer.shop_id,
    r.buyer.customer_id,
  );
  return c.json({
    show_tour: !dismissed && r.buyer.is_b2b,
    day1_features: [
      { id: 'assets', title: 'Dealer assets', description: 'Download line sheets, price lists, and product photography.' },
      { id: 'profile', title: 'Your company profile', description: 'See your tier, team, and tax-exempt status.' },
      { id: 'pricing', title: 'Wholesale pricing', description: 'Tier discounts apply automatically at checkout.' },
    ],
    day2_teasers: [
      { id: 'quick_order', title: 'Quick order form', description: 'Coming soon — paste a SKU list and check out in seconds.' },
      { id: 'saved_lists', title: 'Saved shopping lists', description: 'Coming soon — save common orders and reorder in one click.' },
      { id: 'quotes', title: 'Request a quote', description: 'Coming soon — for bulk orders, get a custom quote.' },
    ],
  });
});

portalRouter.post('/api/tour-dismiss', async c => {
  const r = await resolveBuyerFromProxyQuery(c);
  if (!r.ok) return r.response;
  await dismissTour(c.env.KV_SESSIONS, r.buyer.shop_id, r.buyer.customer_id);
  return c.json({ dismissed: true });
});

portalRouter.get('/api/assets/download/:id/probe', async c => {
  const r = await resolveBuyerFromProxyQuery(c);
  if (!r.ok) return r.response;
  const access = await checkAssetDownloadAccess(c.env, r.buyer, c.req.param('id'));
  switch (access.kind) {
    case 'forbidden':
      return c.json({ error: 'forbidden' }, 403);
    case 'bad_request':
      return c.json({ error: 'invalid id' }, 400);
    case 'not_found':
      return c.json({ error: 'not found' }, 404);
    case 'rate_limited':
      return c.json(
        { error: 'monthly download limit reached; contact the merchant' },
        429,
      );
    case 'server_error':
      return c.json({ error: access.reason }, 500);
    case 'link':
      return c.json({ kind: 'link', url: access.url });
    case 'stream_ready':
      return c.json({ kind: 'stream_ready' });
  }
});

portalRouter.get('/api/assets/download/:id', async c => {
  const r = await resolveBuyerFromProxyQuery(c);
  if (!r.ok) return r.response;
  const result = await buildAssetDownloadResponse(
    c.env,
    r.buyer,
    c.req.param('id'),
    c.req.header('CF-Connecting-IP') ?? null,
  );
  switch (result.kind) {
    case 'forbidden':
      return c.json({ error: 'forbidden' }, 403);
    case 'bad_request':
      return c.json({ error: 'invalid id' }, 400);
    case 'not_found':
      return c.json({ error: 'not found' }, 404);
    case 'rate_limited':
      return c.json(
        { error: 'monthly download limit reached; contact the merchant' },
        429,
      );
    case 'server_error':
      return c.json({ error: result.reason }, 500);
    case 'link':
      return c.json({ url: result.url, expires_in: null });
    case 'stream':
      return new Response(result.body, { status: 200, headers: result.headers });
  }
});

portalRouter.get('/', async c => {
  const shopDomain = c.req.query('shop');
  const customerId = c.req.query('logged_in_customer_id');

  if (!shopDomain) {
    return htmlResponse(errorPage('Missing shop context.'), 400);
  }

  if (!customerId) {
    return htmlResponse(loginRequiredPage(shopDomain), 401);
  }

  const r = await resolveBuyerByCustomerId(c.env, shopDomain, customerId);
  if (!r.ok) {
    if (r.status === 404) {
      return htmlResponse(errorPage('Store not found.'), 404);
    }
    log('warn', 'portal: buyer resolution failed', {
      shop: shopDomain,
      customer: await hashIdAsync(customerId),
      status: r.status,
      error: r.error,
    });
    return htmlResponse(errorPage(r.error), 502);
  }

  if (!r.buyer.is_b2b) {
    return htmlResponse(notWholesalePage(), 403);
  }

  return htmlResponse(
    shellPage({
      shop_domain: r.buyer.shop_domain,
      company_id: r.buyer.shopify_company_id,
      tier_id: r.buyer.tier_id,
      proxy_base: deriveProxyBase(c),
    }),
  );
});

portalRouter.get('/static/app.js', c => {
  return new Response(APP_JS, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
});

portalRouter.get('/static/app.css', c => {
  return new Response(APP_CSS, {
    status: 200,
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
});
