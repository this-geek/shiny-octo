/**
 * Webhook handler for Shopify's `shop/redact` topic.
 *
 * Shopify fires this 48 h after uninstall. We add a 7-day stand-down on top
 * so an accidental uninstall + reinstall does not destroy the shop's data.
 * Total latency: ~9 days from uninstall, well inside compliance windows.
 *
 * Shopify schema:
 *   { shop_id, shop_domain }
 *
 * Note: the shops row may already be gone by the time the sweep fires, if
 * the app/uninstalled handler enqueued an `app_uninstall_purge` that ran
 * earlier. The sweep treats a missing shops row as "already purged".
 */

import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import { dueAtFor, insertGdprRequest } from '../lib/gdpr-store.js';

export async function gdprShopRedactHandler(
  webhookId: string,
  shopDomain: string,
  body: string,
  env: Env,
): Promise<void> {
  const shopRow = await env.DB.prepare(
    `SELECT id FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ id: number }>();

  const now = Math.floor(Date.now() / 1000);
  await insertGdprRequest(env.DB, {
    id: webhookId,
    shop_id: shopRow?.id ?? null,
    shop_domain: shopDomain,
    kind: 'shop_redact',
    shopify_customer_id: null,
    payload_json: body,
    received_at: now,
    due_at: dueAtFor('shop_redact', now),
  });

  log('info', 'gdpr: shop_redact queued (7-day stand-down)', {
    shop: shopDomain,
    webhook_id: webhookId,
  });
}
