import { decrypt } from './crypto.js';
import type { Env } from '../types.js';

export interface ShopAuth {
  shopId: number;
  token: string;
}

/**
 * Resolve a shop_domain to its numeric shop_id and a decrypted access token.
 * Returns null when the shop is not installed (or already uninstalled).
 */
export async function getShopAuth(env: Env, shopDomain: string): Promise<ShopAuth | null> {
  const row = await env.DB.prepare(
    `SELECT id, access_token_encrypted FROM shops
     WHERE shopify_domain = ? AND uninstalled_at IS NULL`,
  )
    .bind(shopDomain)
    .first<{ id: number; access_token_encrypted: string }>();

  if (!row) return null;

  const token = await decrypt(row.access_token_encrypted, shopDomain, env.MASTER_KEY);
  return { shopId: row.id, token };
}
