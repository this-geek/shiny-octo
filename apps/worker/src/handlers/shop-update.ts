import type { Env } from '../types.js';
import { decrypt } from '../lib/crypto.js';
import { log } from '../lib/logger.js';

interface ShopPlanGqlResponse {
  data?: {
    shop?: {
      plan?: {
        shopifyPlus?: boolean;
      };
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * Query the Shopify Admin GraphQL API for the shop's plan info.
 * Returns whether the shop is on Shopify Plus.
 */
export async function queryShopPlan(
  shopDomain: string,
  token: string,
  apiVersion: string,
): Promise<{ shopifyPlus: boolean }> {
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const query = `{
    shop {
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
    throw new Error(`GraphQL request failed with status ${res.status}`);
  }

  const json = (await res.json()) as ShopPlanGqlResponse;

  if (json.errors && json.errors.length > 0) {
    throw new Error(`GraphQL errors: ${json.errors.map(e => e.message).join(', ')}`);
  }

  return {
    shopifyPlus: json.data?.shop?.plan?.shopifyPlus ?? false,
  };
}

/**
 * Handles the shop/update webhook.
 * Re-reads the shop's plan via Admin GraphQL and updates shops.is_plus.
 * This is important because merchants can upgrade/downgrade at any time,
 * which affects whether our tier-discount Function is active.
 */
export async function shopUpdateHandler(shopDomain: string, env: Env): Promise<void> {
  // Look up the shop row to get the encrypted access token
  const row = await env.DB.prepare(
    `SELECT id, access_token_encrypted FROM shops WHERE shopify_domain = ? AND uninstalled_at IS NULL`,
  )
    .bind(shopDomain)
    .first<{ id: number; access_token_encrypted: string }>();

  if (!row) {
    log('warn', 'shop/update: shop not found in D1', { shop: shopDomain });
    return;
  }

  // Decrypt the access token
  let token: string;
  try {
    token = await decrypt(row.access_token_encrypted, shopDomain, env.MASTER_KEY);
  } catch (err) {
    log('error', 'shop/update: failed to decrypt access token', {
      shop: shopDomain,
      error: String(err),
    });
    return;
  }

  // Query Shopify for plan info
  let isPlus: boolean;
  try {
    const plan = await queryShopPlan(shopDomain, token, env.SHOPIFY_API_VERSION);
    isPlus = plan.shopifyPlus;
  } catch (err) {
    log('error', 'shop/update: failed to query shop plan', {
      shop: shopDomain,
      error: String(err),
    });
    return;
  }

  // Update the is_plus flag in D1
  await env.DB.prepare(`UPDATE shops SET is_plus = ? WHERE id = ?`)
    .bind(isPlus ? 1 : 0, row.id)
    .run();

  log('info', 'shop/update: updated is_plus', { shop: shopDomain, is_plus: isPlus });
}
