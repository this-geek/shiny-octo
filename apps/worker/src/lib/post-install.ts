import type { Env } from '../types.js';
import { encrypt } from './crypto.js';
import { ensureMetafieldDefinitions } from './metafield-definitions.js';
import { setShopMetafield } from './shop-metafields.js';
import { log } from './logger.js';

interface ShopPlanResponse {
  data?: {
    shop?: {
      id?: string;
      plan?: { shopifyPlus?: boolean };
    };
  };
}

export async function fetchShopPlan(
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
  const shopId = json.data?.shop?.id ?? '';
  const numericId = shopId.split('/').pop() ?? '0';

  return {
    shopifyPlus: json.data?.shop?.plan?.shopifyPlus ?? false,
    shopId: numericId,
  };
}

/**
 * Persist a freshly-minted offline access token and run the one-time
 * Shopify-side setup (metafield definitions + shop metafield mirrors).
 *
 * Idempotent: the upsert clears `uninstalled_at` so a re-install replaces an
 * old encrypted token in place. Safe to call from either the legacy
 * `/auth/callback` path or the managed-installation token-exchange path.
 */
export async function runPostInstall(
  env: Env,
  shopDomain: string,
  accessToken: string,
): Promise<{ isPlus: boolean }> {
  let isPlus = false;
  let shopifyShopId = '0';
  try {
    const plan = await fetchShopPlan(shopDomain, accessToken, env.SHOPIFY_API_VERSION);
    isPlus = plan.shopifyPlus;
    shopifyShopId = plan.shopId;
  } catch (err) {
    log('warn', 'Could not read shop plan, defaulting to non-Plus', {
      shop: shopDomain,
      error: String(err),
    });
  }

  const encryptedToken = await encrypt(accessToken, shopDomain, env.MASTER_KEY);
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO shops (shopify_domain, shopify_shop_id, access_token_encrypted, is_plus, plan_id, installed_at, settings_json)
     VALUES (?, ?, ?, ?, ?, ?, '{}')
     ON CONFLICT (shopify_domain) DO UPDATE SET
       shopify_shop_id = excluded.shopify_shop_id,
       access_token_encrypted = excluded.access_token_encrypted,
       is_plus = excluded.is_plus,
       plan_id = excluded.plan_id,
       uninstalled_at = NULL`,
  )
    .bind(
      shopDomain,
      parseInt(shopifyShopId, 10),
      encryptedToken,
      isPlus ? 1 : 0,
      isPlus ? 'plus' : 'advanced',
      now,
    )
    .run();

  log('info', 'Shop installed / re-installed', { shop: shopDomain, is_plus: isPlus });

  try {
    await ensureMetafieldDefinitions(shopDomain, accessToken, env.SHOPIFY_API_VERSION);
  } catch (err) {
    log('warn', 'metafield definitions ensure failed', { shop: shopDomain, error: String(err) });
  }

  try {
    await setShopMetafield(
      shopDomain,
      accessToken,
      env.SHOPIFY_API_VERSION,
      'b2b',
      'is_plus',
      'boolean',
      isPlus ? 'true' : 'false',
    );
    await setShopMetafield(
      shopDomain,
      accessToken,
      env.SHOPIFY_API_VERSION,
      'b2b',
      'app_proxy_path',
      'single_line_text_field',
      'apps/b2b',
    );
  } catch (err) {
    log('warn', 'shop metafield mirror failed', { shop: shopDomain, error: String(err) });
  }

  return { isPlus };
}
