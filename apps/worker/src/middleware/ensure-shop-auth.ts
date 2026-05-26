import type { Context, Next } from 'hono';
import type { Env } from '../types.js';
import { getShopAuth } from '../lib/shop-token.js';
import { exchangeForOfflineToken } from '../lib/token-exchange.js';
import { runPostInstall } from '../lib/post-install.js';
import { log } from '../lib/logger.js';

/**
 * Bootstrap a `shops` row on first admin hit when no offline token is on
 * file. Required for managed installation: Shopify never redirects through
 * `/auth/callback`, so the first admin request from App Bridge is our only
 * chance to mint and persist the offline access token via token-exchange.
 *
 * Must run AFTER `sessionTokenMiddleware` so `sessionToken` + `shopDomain`
 * are set on the context.
 */
export async function ensureShopAuthMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  const shopDomain = c.get('shopDomain');
  const existing = await getShopAuth(c.env, shopDomain);
  if (existing) return next();

  const sessionToken = c.get('sessionToken');
  let offlineToken: string;
  try {
    offlineToken = await exchangeForOfflineToken({
      shopDomain,
      sessionToken,
      clientId: c.env.SHOPIFY_API_KEY,
      clientSecret: c.env.SHOPIFY_API_SECRET,
    });
  } catch (err) {
    log('error', 'admin: token exchange failed', { shop: shopDomain, error: String(err) });
    return c.text('shop auth unavailable', 500);
  }

  try {
    await runPostInstall(c.env, shopDomain, offlineToken);
  } catch (err) {
    log('error', 'admin: post-install persist failed', { shop: shopDomain, error: String(err) });
    return c.text('shop auth unavailable', 500);
  }

  return next();
}
