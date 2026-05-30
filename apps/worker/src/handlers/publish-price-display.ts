import type { Env } from '../types.js';
import { buildPriceDisplayConfig } from '../lib/price-display-config.js';
import { parseSettingsBlob } from '../lib/settings.js';
import { setShopMetafield } from '../lib/shop-metafields.js';
import { getShopAuth } from '../lib/shop-token.js';
import { log } from '../lib/logger.js';

/**
 * Mirror the shop's `priceDisplay` settings into the `b2b.price_display`
 * Shop metafield, which the `b2b-price` Theme App Embed reads to drive the
 * site-wide tier-price overlay (DECISIONS #21).
 *
 * Throws on failure so the queue consumer can retry.
 */
export async function publishPriceDisplayHandler(
  shopDomain: string,
  env: Env,
): Promise<void> {
  const auth = await getShopAuth(env, shopDomain);
  if (!auth) {
    log('warn', 'publish-price-display: shop not found', { shop: shopDomain });
    return;
  }

  const row = await env.DB.prepare(`SELECT settings_json FROM shops WHERE shopify_domain = ?`)
    .bind(shopDomain)
    .first<{ settings_json: string }>();

  const settings = parseSettingsBlob(row?.settings_json);
  const config = buildPriceDisplayConfig(settings.priceDisplay);

  await setShopMetafield(
    shopDomain,
    auth.token,
    env.SHOPIFY_API_VERSION,
    'b2b',
    'price_display',
    'json',
    JSON.stringify(config),
  );

  log('info', 'publish-price-display: written', {
    shop: shopDomain,
    site_wide: config.site_wide,
  });
}
