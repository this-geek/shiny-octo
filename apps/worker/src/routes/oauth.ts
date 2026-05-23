import { Hono } from 'hono';
import type { Env } from '../types.js';
import { encrypt } from '../lib/crypto.js';
import { log } from '../lib/logger.js';
import { setShopMetafield } from '../lib/shop-metafields.js';
import { ensureMetafieldDefinitions } from '../lib/metafield-definitions.js';

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

interface ShopPlanResponse {
  data?: {
    shop?: {
      plan?: {
        shopifyPlus?: boolean;
      };
    };
  };
}

async function fetchShopPlan(
  shopDomain: string,
  token: string,
  apiVersion: string,
): Promise<{ shopifyPlus: boolean; shopId: string }> {
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const query = `{
    shop {
      id
      plan {
        shopifyPlus
      }
    }
  }`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status}`);
  }

  const json = (await res.json()) as ShopPlanResponse;
  const plan = json.data?.shop?.plan;
  const shopId = (json.data as { shop?: { id?: string } })?.shop?.id ?? '';
  // Shop GID looks like "gid://shopify/Shop/12345"
  const numericId = shopId.split('/').pop() ?? '0';

  return {
    shopifyPlus: plan?.shopifyPlus ?? false,
    shopId: numericId,
  };
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

  // 4. Read shop plan info
  let isPlus = false;
  let shopifyShopId = '0';
  try {
    const plan = await fetchShopPlan(shop, token, c.env.SHOPIFY_API_VERSION);
    isPlus = plan.shopifyPlus;
    shopifyShopId = plan.shopId;
  } catch (err) {
    log('warn', 'Could not read shop plan, defaulting to non-Plus', { shop, error: String(err) });
  }

  // 5. Encrypt access token
  const encryptedToken = await encrypt(token, shop, c.env.MASTER_KEY);

  // 6. Upsert shop row in D1
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO shops (shopify_domain, shopify_shop_id, access_token_encrypted, is_plus, plan_id, installed_at, settings_json)
     VALUES (?, ?, ?, ?, ?, ?, '{}')
     ON CONFLICT (shopify_domain) DO UPDATE SET
       shopify_shop_id = excluded.shopify_shop_id,
       access_token_encrypted = excluded.access_token_encrypted,
       is_plus = excluded.is_plus,
       plan_id = excluded.plan_id,
       uninstalled_at = NULL`,
  )
    .bind(shop, parseInt(shopifyShopId, 10), encryptedToken, isPlus ? 1 : 0, isPlus ? 'plus' : 'advanced', now)
    .run();

  log('info', 'Shop installed / re-installed', { shop, is_plus: isPlus });

  // 7. Ensure metafield definitions exist (idempotent — TAKEN errors are swallowed).
  try {
    await ensureMetafieldDefinitions(shop, token, c.env.SHOPIFY_API_VERSION);
  } catch (err) {
    log('warn', 'metafield definitions ensure failed', { shop, error: String(err) });
  }

  // 8. Mirror is_plus + app_proxy_path to Shop metafields so Functions can read them.
  try {
    await setShopMetafield(shop, token, c.env.SHOPIFY_API_VERSION, 'b2b', 'is_plus', 'boolean', isPlus ? 'true' : 'false');
    await setShopMetafield(shop, token, c.env.SHOPIFY_API_VERSION, 'b2b', 'app_proxy_path', 'single_line_text_field', 'apps/b2b');
  } catch (err) {
    log('warn', 'shop metafield mirror failed', { shop, error: String(err) });
  }

  // 9. Redirect to app in admin
  return c.redirect(`https://${shop}/admin/apps/${c.env.SHOPIFY_API_KEY}`);
});
