import { Hono } from 'hono';
import type { Env } from '../types.js';
import { appProxyMiddleware } from '../middleware/app-proxy-hmac.js';
import { decrypt } from '../lib/crypto.js';
import { log } from '../lib/logger.js';
import { hashIdAsync } from '../lib/logger.js';

export const appProxyRouter = new Hono<{ Bindings: Env }>();

appProxyRouter.use('*', appProxyMiddleware);

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
