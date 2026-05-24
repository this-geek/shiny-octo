import type { Env } from '../types.js';
import { setMetafields } from '../lib/metafields.js';
import { getShopAuth } from '../lib/shop-token.js';
import { log } from '../lib/logger.js';

export interface MirrorCompanyTierPayload {
  shopify_company_id: string;
  tier_id: number | null;
}

/**
 * Write the `b2b.tier_id` metafield onto a Shopify Company GID. When tier_id
 * is null, write 0 — Shopify's metafield API does not support deletion via
 * metafieldsSet, and Functions treat the 0 sentinel as "no tier".
 *
 * Throws on failure so the queue consumer can retry.
 */
export async function mirrorCompanyTierHandler(
  shopDomain: string,
  payload: MirrorCompanyTierPayload,
  env: Env,
): Promise<void> {
  const auth = await getShopAuth(env, shopDomain);
  if (!auth) {
    log('warn', 'mirror-company-tier: shop not found', { shop: shopDomain });
    return;
  }

  const value = String(payload.tier_id ?? 0);

  await setMetafields(shopDomain, auth.token, env.SHOPIFY_API_VERSION, [
    {
      ownerId: payload.shopify_company_id,
      namespace: 'b2b',
      key: 'tier_id',
      type: 'number_integer',
      value,
    },
  ]);

  log('info', 'mirror-company-tier: written', {
    shop: shopDomain,
    company: payload.shopify_company_id,
    tier_id: payload.tier_id,
  });
}
