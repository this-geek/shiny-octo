import { Hono } from 'hono';
import type { Env } from '../types.js';
import { appProxyMiddleware } from '../middleware/app-proxy-hmac.js';
import { decrypt } from '../lib/crypto.js';
import { hashIdAsync, log } from '../lib/logger.js';
import { resolveBuyerByCustomerId } from '../lib/buyer-context.js';
import {
  buildAssetListResponse,
  buildAssetDownloadResponse,
  checkAssetDownloadAccess,
} from '../lib/asset-serve.js';
import { appProxyApplicationsRouter } from './app-proxy-applications.js';
import { portalRouter } from './portal.js';

export const appProxyRouter = new Hono<{ Bindings: Env }>();

appProxyRouter.use('*', appProxyMiddleware);

// Phase 1E — wholesale application form. Routes start with /application/*.
appProxyRouter.route('/', appProxyApplicationsRouter);

// Buyer-facing dealer asset portal (Worker-rendered HTML, reached via App
// Proxy at <shop>/apps/b2b/portal). Replaces the customer-account.page.render
// UI extension path.
appProxyRouter.route('/portal', portalRouter);

interface CustomerCompanyResp {
  data?: {
    customer?: {
      companyContactProfiles?: Array<{ company?: { id?: string } }>;
    };
  };
  errors?: Array<{ message: string }>;
}

async function lookupCustomerCompany(
  shopDomain: string,
  token: string,
  apiVersion: string,
  customerId: string,
): Promise<string | null> {
  const customerGid = customerId.startsWith('gid://')
    ? customerId
    : `gid://shopify/Customer/${customerId}`;
  const query = `query CompanyForCustomer($id: ID!) {
    customer(id: $id) {
      companyContactProfiles { company { id } }
    }
  }`;
  const res = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables: { id: customerGid } }),
    },
  );
  if (!res.ok) throw new Error(`customer lookup HTTP ${res.status}`);
  const json = (await res.json()) as CustomerCompanyResp;
  if (json.errors?.length) {
    throw new Error(`customer lookup errors: ${json.errors.map(e => e.message).join(', ')}`);
  }
  return json.data?.customer?.companyContactProfiles?.[0]?.company?.id ?? null;
}

interface CachedTier {
  tier: { id: number; name: string; discount_type: string; discount_value: number } | null;
  b2b: boolean;
  company_id: string | null;
  /** True on Shopify Plus, where the tier-discount Function is disabled. */
  plus?: boolean;
}

appProxyRouter.get('/tier-context', async c => {
  const shopDomain = c.req.query('shop');
  const customerId = c.req.query('logged_in_customer_id');

  if (!shopDomain) return c.json({ tier: null, b2b: false });

  if (!customerId) {
    return c.json({ tier: null, b2b: false });
  }

  const shopRow = await c.env.DB.prepare(
    `SELECT id, shopify_domain, access_token_encrypted, is_plus FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{
      id: number;
      shopify_domain: string;
      access_token_encrypted: string;
      is_plus: number;
    }>();

  if (!shopRow) {
    return c.json({ tier: null, b2b: false });
  }

  // On Plus the tier-discount Function early-returns (native Catalogs do the
  // pricing), so the storefront overlay MUST NOT apply a discount either — it
  // would show a price that doesn't survive checkout. We still resolve B2B
  // membership (b2b_only gating depends on it); we just never hand back a tier.
  const isPlus = shopRow.is_plus === 1;

  const customerHash = await hashIdAsync(customerId);
  const cacheKey = `tier:${shopRow.id}:${customerHash}`;
  const cached = await c.env.KV_HOT_CACHE.get(cacheKey);
  if (cached) {
    try {
      return c.json(JSON.parse(cached) as CachedTier);
    } catch {
      // Cache poisoned — fall through to a fresh resolve and overwrite.
    }
  }

  let token: string;
  try {
    token = await decrypt(shopRow.access_token_encrypted, shopDomain, c.env.MASTER_KEY);
  } catch (err) {
    log('error', 'tier-context: failed to decrypt access token', {
      shop: shopDomain,
      error: String(err),
    });
    return c.json({ tier: null, b2b: false });
  }

  let companyId: string | null;
  try {
    companyId = await lookupCustomerCompany(
      shopDomain,
      token,
      c.env.SHOPIFY_API_VERSION,
      customerId,
    );
  } catch (err) {
    log('warn', 'tier-context: customer→company lookup failed', {
      shop: shopDomain,
      error: String(err),
    });
    return c.json({ tier: null, b2b: false });
  }

  if (!companyId) {
    const result: CachedTier = { tier: null, b2b: false, company_id: null };
    await c.env.KV_HOT_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 });
    return c.json({ tier: null, b2b: false });
  }

  const tierRow = await c.env.DB.prepare(
    `SELECT t.id AS tier_id, t.name, t.discount_type, t.discount_value
     FROM company_tier_mappings m
     JOIN tiers t ON t.id = m.tier_id
     WHERE m.shop_id = ? AND m.shopify_company_id = ? AND t.deleted_at IS NULL`,
  )
    .bind(shopRow.id, companyId)
    .first<{ tier_id: number; name: string; discount_type: string; discount_value: number }>();

  const result: CachedTier =
    tierRow && !isPlus
      ? {
          b2b: true,
          company_id: companyId,
          tier: {
            id: tierRow.tier_id,
            name: tierRow.name,
            discount_type: tierRow.discount_type,
            discount_value: tierRow.discount_value,
          },
        }
      : { b2b: true, company_id: companyId, tier: null, plus: isPlus };

  await c.env.KV_HOT_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 });

  return c.json(result);
});

// ---------------------------------------------------------------------------
// Buyer asset portal (App Proxy entry — Customer Account UI uses its own
// router with session-token auth; both share lib/asset-serve.ts so the
// visibility + bandwidth rules are identical).
// ---------------------------------------------------------------------------

appProxyRouter.get('/assets/list', async c => {
  const shopDomain = c.req.query('shop');
  const customerId = c.req.query('logged_in_customer_id');
  if (!shopDomain) return c.json({ error: 'missing shop' }, 400);
  if (!customerId) return c.json({ error: 'login required' }, 401);

  const r = await resolveBuyerByCustomerId(c.env, shopDomain, customerId);
  if (!r.ok) return c.json({ error: r.error }, r.status as 400 | 401 | 404 | 502);
  const body = await buildAssetListResponse(c.env, r.buyer);
  return c.json(body);
});

appProxyRouter.get('/assets/download/:id/probe', async c => {
  const shopDomain = c.req.query('shop');
  const customerId = c.req.query('logged_in_customer_id');
  if (!shopDomain) return c.json({ error: 'missing shop' }, 400);
  if (!customerId) return c.json({ error: 'login required' }, 401);

  const r = await resolveBuyerByCustomerId(c.env, shopDomain, customerId);
  if (!r.ok) return c.json({ error: r.error }, r.status as 400 | 401 | 404 | 502);

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

appProxyRouter.get('/assets/download/:id', async c => {
  const shopDomain = c.req.query('shop');
  const customerId = c.req.query('logged_in_customer_id');
  if (!shopDomain) return c.json({ error: 'missing shop' }, 400);
  if (!customerId) return c.json({ error: 'login required' }, 401);

  const r = await resolveBuyerByCustomerId(c.env, shopDomain, customerId);
  if (!r.ok) return c.json({ error: r.error }, r.status as 400 | 401 | 404 | 502);

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
