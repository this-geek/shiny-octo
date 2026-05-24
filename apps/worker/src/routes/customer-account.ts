import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '../types.js';
import { customerAccountTokenMiddleware } from '../middleware/customer-account-token.js';
import { resolveBuyerByCustomerId } from '../lib/buyer-context.js';
import { buildAssetListResponse, buildAssetDownloadResponse } from '../lib/asset-serve.js';

/**
 * Routes for the Customer Account UI extension (dealer asset portal).
 *
 * Auth is via the Customer Account session token — Shopify mints an
 * HS256 JWT on every render and the extension passes it as a Bearer
 * Authorization header. The middleware extracts shop_domain + customer_id
 * (gid://shopify/Customer/<id>); we then run the same visibility +
 * bandwidth logic as the legacy App Proxy /apps/<prefix>/assets/* route.
 *
 * CORS allows the Shopify customer-account host since the extension's
 * fetch() originates from shopify.com (or shop.account.*).
 */
export const customerAccountRouter = new Hono<{ Bindings: Env }>();

customerAccountRouter.use(
  '*',
  cors({
    origin: origin =>
      origin && /\.shopify\.com$|\.myshopify\.com$|\.shopify-account\.com$/.test(origin)
        ? origin
        : null,
    allowMethods: ['GET'],
    allowHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
    maxAge: 600,
  }),
);

customerAccountRouter.use('*', customerAccountTokenMiddleware);

customerAccountRouter.get('/assets/list', async c => {
  const ctx = c.var.customerAccount;
  const r = await resolveBuyerByCustomerId(c.env, ctx.shop_domain, ctx.customer_id);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 502);
  const body = await buildAssetListResponse(c.env, r.buyer);
  return c.json(body);
});

customerAccountRouter.get('/assets/download/:id', async c => {
  const ctx = c.var.customerAccount;
  const r = await resolveBuyerByCustomerId(c.env, ctx.shop_domain, ctx.customer_id);
  if (!r.ok) return c.json({ error: r.error }, r.status as 404 | 502);

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
