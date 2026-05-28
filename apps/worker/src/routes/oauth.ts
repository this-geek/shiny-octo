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

// Subdomain: 3-60 chars, lowercase alphanumeric + hyphens, must start alphanumeric.
// Full domain therefore caps at 60 + ".myshopify.com" (15) = 75 chars.
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9\-]{2,59}\.myshopify\.com$/;
const SHOP_DOMAIN_MAX_LEN = 75;

const STATE_COOKIE = 'oauth_state';
const STATE_COOKIE_TTL_S = 600;

function normalizeShopDomain(raw: string | null | undefined): string | null {
  if (!raw || raw.length > SHOP_DOMAIN_MAX_LEN) return null;
  const lower = raw.toLowerCase();
  return SHOP_DOMAIN_RE.test(lower) ? lower : null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function getCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

function setStateCookie(value: string): string {
  return `${STATE_COOKIE}=${value}; Path=/; Max-Age=${STATE_COOKIE_TTL_S}; HttpOnly; Secure; SameSite=Lax`;
}

function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
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
  return timingSafeEqual(computed, provided);
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
  const shop = normalizeShopDomain(c.req.query('shop'));

  if (!shop) {
    return c.text('Invalid shop parameter', 400);
  }

  // Cryptographically random nonce (16 bytes → 32 hex chars).
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = bytesToHex(nonceBytes);

  // Key by the nonce so concurrent /auth calls for the same shop cannot
  // overwrite each other's pending state. The value records the shop the
  // nonce was issued for, so the callback can verify the shop matches.
  await c.env.KV_SESSIONS.put(`oauth:nonce:${nonce}`, shop, {
    expirationTtl: STATE_COOKIE_TTL_S,
  });

  // Bind the state to the initiating browser via a signed/cookie pair.
  // Without this, any actor that can trigger /auth?shop=victim produces a
  // valid nonce the victim's browser would then complete (login-CSRF).
  c.header('Set-Cookie', setStateCookie(nonce));

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
  const rawShop = params.get('shop');
  const code = params.get('code');
  const state = params.get('state');
  const hmac = params.get('hmac');

  if (!rawShop || !code || !state || !hmac) {
    return c.text('Missing required parameters', 400);
  }

  const shop = normalizeShopDomain(rawShop);
  if (!shop) {
    return c.text('Invalid shop domain', 400);
  }

  // 1. Verify HMAC of all query params.
  const hmacValid = await verifyOAuthHmac(params, c.env.SHOPIFY_API_SECRET);
  if (!hmacValid) {
    log('warn', 'OAuth callback HMAC verification failed', { shop });
    return c.text('Unauthorized', 401);
  }

  // 2. Verify the state cookie matches the state query param (CSRF binding).
  const cookieState = getCookie(c.req.header('cookie'), STATE_COOKIE);
  if (!cookieState || !timingSafeEqual(cookieState, state)) {
    log('warn', 'OAuth callback state cookie missing or mismatched', { shop });
    c.header('Set-Cookie', clearStateCookie());
    return c.text('Invalid state parameter', 401);
  }

  // 3. Verify nonce exists in KV (single-use; also proves /auth was the origin).
  const storedShop = await c.env.KV_SESSIONS.get(`oauth:nonce:${state}`);
  if (!storedShop) {
    log('warn', 'OAuth callback nonce missing or already consumed', { shop });
    c.header('Set-Cookie', clearStateCookie());
    return c.text('Invalid state parameter', 401);
  }

  // 4. The nonce's recorded shop must match the callback's shop, so an
  // attacker can't replay a nonce issued for one shop against another.
  if (!timingSafeEqual(storedShop, shop)) {
    log('warn', 'OAuth callback shop does not match stored nonce shop', {
      shop,
      storedShop,
    });
    // Do NOT consume the KV entry: the legitimate browser should still be
    // able to complete its own callback.
    return c.text('Invalid state parameter', 401);
  }

  // Consume the nonce + clear the cookie — single use, no replay.
  await c.env.KV_SESSIONS.delete(`oauth:nonce:${state}`);
  c.header('Set-Cookie', clearStateCookie());

  // 5. Exchange code for access token.
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

  // 6. Persist + run post-install setup (shared with managed-installation flow).
  await runPostInstall(c.env, shop, token);

  // 7. Redirect to app in admin.
  return c.redirect(`https://${shop}/admin/apps/${c.env.SHOPIFY_API_KEY}`);
});
