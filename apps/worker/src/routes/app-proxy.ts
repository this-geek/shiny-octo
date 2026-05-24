import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { appProxyMiddleware } from '../middleware/app-proxy-hmac.js';
import { decrypt } from '../lib/crypto.js';
import { log } from '../lib/logger.js';
import { hashIdAsync } from '../lib/logger.js';
import { getAsset, logAssetDownload, type Asset } from '../lib/asset-store.js';
import { isAssetVisible, listVisibleAssets } from '../lib/asset-visibility.js';
import { assertWithinBudget, recordDownload } from '../lib/bandwidth-counter.js';
import { assertKeyBelongsToShop } from '../lib/r2-keys.js';
import { appProxyApplicationsRouter } from './app-proxy-applications.js';

export const appProxyRouter = new Hono<{ Bindings: Env }>();

appProxyRouter.use('*', appProxyMiddleware);

// Phase 1E — wholesale application form. Routes start with /application/*.
appProxyRouter.route('/', appProxyApplicationsRouter);

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
}

appProxyRouter.get('/tier-context', async c => {
  const shopDomain = c.req.query('shop');
  const customerId = c.req.query('logged_in_customer_id');

  if (!shopDomain) return c.json({ tier: null, b2b: false });

  if (!customerId) {
    return c.json({ tier: null, b2b: false });
  }

  const shopRow = await c.env.DB.prepare(
    `SELECT id, shopify_domain, access_token_encrypted FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ id: number; shopify_domain: string; access_token_encrypted: string }>();

  if (!shopRow) {
    return c.json({ tier: null, b2b: false });
  }

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

  const result: CachedTier = tierRow
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
    : { b2b: true, company_id: companyId, tier: null };

  await c.env.KV_HOT_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 });

  return c.json(result);
});

// ---------------------------------------------------------------------------
// Buyer asset portal
// ---------------------------------------------------------------------------

interface BuyerCtx {
  shop_id: number;
  shop_domain: string;
  shopify_company_id: string | null;
  tier_id: number | null;
  is_b2b: boolean;
  customer_id: string;
}

async function resolveBuyer(
  c: Context<{ Bindings: Env }>,
): Promise<BuyerCtx | { error: Response }> {
  const shopDomain = c.req.query('shop');
  const customerId = c.req.query('logged_in_customer_id');
  if (!shopDomain) {
    return { error: c.json({ error: 'missing shop' }, 400) };
  }
  if (!customerId) {
    return { error: c.json({ error: 'login required' }, 401) };
  }

  const shopRow = await c.env.DB.prepare(
    `SELECT id, shopify_domain, access_token_encrypted FROM shops
     WHERE shopify_domain = ? AND uninstalled_at IS NULL`,
  )
    .bind(shopDomain)
    .first<{ id: number; shopify_domain: string; access_token_encrypted: string }>();
  if (!shopRow) {
    return { error: c.json({ error: 'shop not found' }, 404) };
  }

  // Reuse the tier-context resolution path (cache included) so we don't refetch
  // the customer→company link on every list/download call.
  const customerHash = await hashIdAsync(customerId);
  const cacheKey = `tier:${shopRow.id}:${customerHash}`;
  let cached: { b2b: boolean; company_id: string | null; tier: { id: number } | null } | null = null;
  const raw = await c.env.KV_HOT_CACHE.get(cacheKey);
  if (raw) {
    try {
      cached = JSON.parse(raw);
    } catch {
      cached = null;
    }
  }

  if (!cached) {
    let token: string;
    try {
      token = await decrypt(shopRow.access_token_encrypted, shopDomain, c.env.MASTER_KEY);
    } catch {
      return { error: c.json({ error: 'shop auth unavailable' }, 502) };
    }
    let companyId: string | null;
    try {
      companyId = await lookupCustomerCompany(
        shopDomain,
        token,
        c.env.SHOPIFY_API_VERSION,
        customerId,
      );
    } catch {
      return { error: c.json({ error: 'customer lookup failed' }, 502) };
    }
    if (!companyId) {
      cached = { b2b: false, company_id: null, tier: null };
    } else {
      const tierRow = await c.env.DB.prepare(
        `SELECT t.id AS tier_id
         FROM company_tier_mappings m
         JOIN tiers t ON t.id = m.tier_id
         WHERE m.shop_id = ? AND m.shopify_company_id = ? AND t.deleted_at IS NULL`,
      )
        .bind(shopRow.id, companyId)
        .first<{ tier_id: number }>();
      cached = {
        b2b: true,
        company_id: companyId,
        tier: tierRow ? { id: tierRow.tier_id } : null,
      };
    }
    await c.env.KV_HOT_CACHE.put(cacheKey, JSON.stringify(cached), { expirationTtl: 300 });
  }

  return {
    shop_id: shopRow.id,
    shop_domain: shopDomain,
    shopify_company_id: cached.company_id,
    tier_id: cached.tier?.id ?? null,
    is_b2b: cached.b2b,
    customer_id: customerId,
  };
}

appProxyRouter.get('/assets/list', async c => {
  const result = await resolveBuyer(c);
  if ('error' in result) return result.error;
  if (!result.is_b2b) return c.json({ assets: [] });

  const assets = await listVisibleAssets(c.env.DB, result);
  // Strip r2_key and internal fields before returning to the buyer.
  const safe = assets.map(a => ({
    id: a.id,
    folder_id: a.folder_id,
    type: a.type,
    title: a.title,
    description: a.description,
    file_size_bytes: a.file_size_bytes,
    mime_type: a.mime_type,
    external_url: a.type === 'link' ? a.external_url : null,
    uploaded_at: a.uploaded_at,
  }));
  return c.json({ assets: safe });
});

appProxyRouter.get('/assets/download/:id', async c => {
  const result = await resolveBuyer(c);
  if ('error' in result) return result.error;
  if (!result.is_b2b) return c.json({ error: 'forbidden' }, 403);

  const assetId = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    return c.json({ error: 'invalid id' }, 400);
  }

  const asset = await getAsset(c.env.DB, result.shop_id, assetId);
  if (!asset || asset.deleted_at !== null) {
    return c.json({ error: 'not found' }, 404);
  }
  if (!(await isAssetVisible(c.env.DB, asset, result))) {
    // Same response shape as 404 so we don't leak existence.
    return c.json({ error: 'not found' }, 404);
  }

  // Link assets just bounce the buyer to the external URL.
  if (asset.type === 'link') {
    if (!asset.external_url) return c.json({ error: 'missing url' }, 500);
    await recordDownloadAndLog(c.env, asset, result, 0, c.req.header('CF-Connecting-IP') ?? null);
    return c.json({ url: asset.external_url, expires_in: null });
  }

  // Bandwidth gate (DECISIONS #14).
  const budget = await assertWithinBudget(c.env.KV_HOT_CACHE, result.shop_id);
  if (!budget.withinBudget) {
    log('warn', 'assets/download: monthly bandwidth ceiling hit', {
      shop_id: result.shop_id,
      used_bytes: budget.usedBytes,
    });
    return c.json(
      { error: 'monthly download limit reached; contact the merchant' },
      429,
    );
  }

  if (!asset.r2_key) return c.json({ error: 'asset has no file' }, 500);
  assertKeyBelongsToShop(asset.r2_key, result.shop_id);

  // The buyer downloads via the proxy itself — we stream the object out and
  // never hand them an R2 URL directly. This keeps R2 fully private and means
  // the same code path enforces visibility + counts bandwidth.
  const obj = await c.env.ASSETS_BUCKET.get(asset.r2_key);
  if (!obj) return c.json({ error: 'file not found' }, 404);

  const bytes = asset.file_size_bytes ?? obj.size ?? 0;
  const ip = c.req.header('CF-Connecting-IP') ?? null;
  await recordDownloadAndLog(c.env, asset, result, bytes, ip);

  const headers = new Headers();
  if (asset.mime_type) headers.set('Content-Type', asset.mime_type);
  headers.set(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(asset.title)}"`,
  );
  if (bytes) headers.set('Content-Length', String(bytes));
  headers.set('Cache-Control', 'private, no-store');
  return new Response(obj.body, { status: 200, headers });
});

async function recordDownloadAndLog(
  env: Env,
  asset: Asset,
  buyer: BuyerCtx,
  bytes: number,
  ip: string | null,
): Promise<void> {
  const customerHash = await hashIdAsync(buyer.customer_id);
  // IP is best-effort: Workers populate CF-Connecting-IP when the request
  // hits a deployed edge. Fall back to a deterministic per-customer hash so
  // the column is never NULL (the schema requires it).
  const ipHash = await hashIdAsync(ip ? `ip:${ip}` : `cust:${buyer.customer_id}`);
  try {
    await logAssetDownload(
      env.DB,
      buyer.shop_id,
      asset.id,
      buyer.shopify_company_id ?? '',
      customerHash,
      ipHash,
    );
  } catch (err) {
    log('warn', 'asset download log failed', {
      shop_id: buyer.shop_id,
      asset_id: asset.id,
      error: String(err),
    });
  }
  if (bytes > 0) {
    await recordDownload(env.KV_HOT_CACHE, buyer.shop_id, bytes);
  }
}
