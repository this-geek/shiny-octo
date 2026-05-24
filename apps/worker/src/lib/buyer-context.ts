import type { Env } from '../types.js';
import { decrypt } from './crypto.js';
import { hashIdAsync, log } from './logger.js';

/**
 * Shared buyer-context resolver used by both the App Proxy and the Customer
 * Account UI extension paths. Looks up the customer's Shopify Company +
 * mapped tier and caches the result in KV for 5 minutes (UX cache only;
 * downstream authorisation re-checks visibility on every request — see
 * asset-visibility.ts).
 */
export interface BuyerCtx {
  shop_id: number;
  shop_domain: string;
  shopify_company_id: string | null;
  tier_id: number | null;
  is_b2b: boolean;
  customer_id: string;
}

export type BuyerCtxResult = { ok: true; buyer: BuyerCtx } | { ok: false; status: number; error: string };

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

export async function resolveBuyerByCustomerId(
  env: Env,
  shopDomain: string,
  customerId: string,
): Promise<BuyerCtxResult> {
  const shopRow = await env.DB.prepare(
    `SELECT id, shopify_domain, access_token_encrypted FROM shops
     WHERE shopify_domain = ? AND uninstalled_at IS NULL`,
  )
    .bind(shopDomain)
    .first<{ id: number; shopify_domain: string; access_token_encrypted: string }>();
  if (!shopRow) return { ok: false, status: 404, error: 'shop not found' };

  const customerHash = await hashIdAsync(customerId);
  const cacheKey = `tier:${shopRow.id}:${customerHash}`;
  let cached: { b2b: boolean; company_id: string | null; tier: { id: number } | null } | null = null;
  const raw = await env.KV_HOT_CACHE.get(cacheKey);
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
      token = await decrypt(shopRow.access_token_encrypted, shopDomain, env.MASTER_KEY);
    } catch {
      return { ok: false, status: 502, error: 'shop auth unavailable' };
    }
    let companyId: string | null;
    try {
      companyId = await lookupCustomerCompany(
        shopDomain,
        token,
        env.SHOPIFY_API_VERSION,
        customerId,
      );
    } catch (err) {
      log('warn', 'buyer-context: customer→company lookup failed', {
        shop: shopDomain,
        error: String(err),
      });
      return { ok: false, status: 502, error: 'customer lookup failed' };
    }
    if (!companyId) {
      cached = { b2b: false, company_id: null, tier: null };
    } else {
      const tierRow = await env.DB.prepare(
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
    await env.KV_HOT_CACHE.put(cacheKey, JSON.stringify(cached), { expirationTtl: 300 });
  }

  return {
    ok: true,
    buyer: {
      shop_id: shopRow.id,
      shop_domain: shopDomain,
      shopify_company_id: cached.company_id,
      tier_id: cached.tier?.id ?? null,
      is_b2b: cached.b2b,
      customer_id: customerId,
    },
  };
}
