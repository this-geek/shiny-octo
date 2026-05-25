import { Hono } from 'hono';
import type { Env } from '../types.js';
import { resolveBuyerByCustomerId } from '../lib/buyer-context.js';
import { hashIdAsync, log } from '../lib/logger.js';

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
  "style-src 'self' 'unsafe-inline'",
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

function shellPage(boot: { shop_domain: string; company_id: string | null; tier_id: number | null }): string {
  const bootJson = JSON.stringify(boot)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dealer portal</title>
</head>
<body>
<main id="b2b-portal-root">
<h1>Dealer portal</h1>
<p>Loading…</p>
</main>
<script id="b2b-portal-boot" type="application/json">${bootJson}</script>
</body>
</html>`;
}

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
    }),
  );
});
