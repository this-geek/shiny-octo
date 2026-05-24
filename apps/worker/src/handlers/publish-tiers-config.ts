import type { Env } from '../types.js';
import { listActiveTiers } from '../lib/tier-store.js';
import { buildTiersConfig } from '../lib/tiers-config.js';
import { setShopMetafield } from '../lib/shop-metafields.js';
import { getShopAuth } from '../lib/shop-token.js';
import { log } from '../lib/logger.js';

/**
 * Re-publish the shop's full tier set into the `b2b.tiers_config` Shop metafield.
 * Functions read this metafield on every cart-transform / cart-validation /
 * delivery-customization invocation.
 *
 * Throws on failure so the queue consumer can retry.
 */
export async function publishTiersConfigHandler(
  shopDomain: string,
  env: Env,
): Promise<void> {
  const auth = await getShopAuth(env, shopDomain);
  if (!auth) {
    log('warn', 'publish-tiers-config: shop not found', { shop: shopDomain });
    return;
  }

  const tiers = await listActiveTiers(env.DB, auth.shopId);
  const config = buildTiersConfig(tiers);

  await setShopMetafield(
    shopDomain,
    auth.token,
    env.SHOPIFY_API_VERSION,
    'b2b',
    'tiers_config',
    'json',
    JSON.stringify(config),
  );

  log('info', 'publish-tiers-config: written', {
    shop: shopDomain,
    tier_count: tiers.length,
  });
}
