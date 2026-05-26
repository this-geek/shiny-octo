import { Hono } from 'hono';
import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import { runPostInstall } from '../lib/post-install.js';

const SCOPES = [
  'read_customers',
  'write_customers',
  'read_products',
  'write_products',
  'read_orders',
  'write_orders',
  'read_companies',
  'write_companies',
  'read_files',
  'write_files',
  'read_themes',
  'write_themes',
  'read_locales',
  'read_payment_terms',
  'write_payment_terms',
  'read_markets',
  'read_shipping',
  'write_shipping',
].join(',');

const SHOP_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;

function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_RE.test(shop);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify the HMAC on OAuth callback query parameters.
 * Sorts all params alphabetically (excluding 'hmac'), joins as key=value pairs,
 * and computes HMAC-SHA256 with the API secret, comparing hex digests.
 */
async function verifyOAuthHmac(
  params: URLSearchParams,
  apiSecret: string,
): Promise<boolean> {
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hmac') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const message = pairs.join('&');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const computed = bytesToHex(new Uint8Array(sig));

  const provided = params.get('hmac') ?? '';

  // Timing-safe comparison
  if (computed.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

async function exchangeCodeForToken(
  shopDomain: string,
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status}`);
  }

  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('No access_token in response');
  return json.access_token;
}

export const oauthRouter = new Hono<{ Bindings: Env }>();

/**
 * GET /auth?shop=example.myshopify.com
 * Initiates the Shopify OAuth flow.
 */
oauthRouter.get('/', async c => {
  const shop = c.req.query('shop');

  if (!shop || !isValidShopDomain(shop)) {
    return c.text('Invalid shop parameter', 400);
  }

  // Generate a cryptographically random nonce (16 bytes → 32 hex chars)
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = bytesToHex(nonceBytes);

  // Store nonce in KV_SESSIONS with 10-minute TTL
  await c.env.KV_SESSIONS.put(`oauth:nonce:${shop}`, nonce, { expirationTtl: 600 });

  const redirectUri = `${c.env.APP_URL}/auth/callback`;
  const authUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authUrl.searchParams.set('client_id', c.env.SHOPIFY_API_KEY);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', nonce);

  log('info', 'OAuth flow initiated', { shop });

  return c.redirect(authUrl.toString());
});

/**
 * GET /auth/callback?code=...&hmac=...&shop=...&state=...&timestamp=...
 * Handles the Shopify OAuth callback.
 */
oauthRouter.get('/callback', async c => {
  const params = new URLSearchParams(c.req.url.split('?')[1] ?? '');
  const shop = params.get('shop');
  const code = params.get('code');
  const state = params.get('state');
  const hmac = params.get('hmac');

  if (!shop || !code || !state || !hmac) {
    return c.text('Missing required parameters', 400);
  }

  if (!isValidShopDomain(shop)) {
    return c.text('Invalid shop domain', 400);
  }

  // 1. Verify HMAC of all query params
  const hmacValid = await verifyOAuthHmac(params, c.env.SHOPIFY_API_SECRET);
  if (!hmacValid) {
    log('warn', 'OAuth callback HMAC verification failed', { shop });
    return c.text('Unauthorized', 401);
  }

  // 2. Verify nonce (state) from KV
  const storedNonce = await c.env.KV_SESSIONS.get(`oauth:nonce:${shop}`);
  if (!storedNonce || storedNonce !== state) {
    log('warn', 'OAuth callback nonce mismatch', { shop });
    return c.text('Invalid state parameter', 401);
  }

  // Delete the nonce — single use
  await c.env.KV_SESSIONS.delete(`oauth:nonce:${shop}`);

  // 3. Exchange code for access token
  let token: string;
  try {
    token = await exchangeCodeForToken(
      shop,
      code,
      c.env.SHOPIFY_API_KEY,
      c.env.SHOPIFY_API_SECRET,
    );
  } catch (err) {
    log('error', 'OAuth token exchange failed', { shop, error: String(err) });
    return c.text('Token exchange failed', 500);
  }

  // 4. Persist + run post-install setup (shared with managed-installation flow).
  await runPostInstall(c.env, shop, token);

  // 5. Redirect to app in admin
  return c.redirect(`https://${shop}/admin/apps/${c.env.SHOPIFY_API_KEY}`);
});
