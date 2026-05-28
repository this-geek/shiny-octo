import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import {
  APP_UNINSTALL_PURGE_GRACE_S,
  dueAtFor,
  insertGdprRequest,
} from '../lib/gdpr-store.js';

/**
 * Handles the app/uninstalled webhook.
 * Soft-marks the shop as uninstalled, then enqueues an `app_uninstall_purge`
 * row in `gdpr_requests` due 30 days later (Shopify's mandatory retention
 * floor). The daily sweep runs the same `redactShop` purge used for an
 * explicit `shop/redact`. If the merchant reinstalls and a follow-up
 * Shopify `shop/redact` never fires, this row still cleans things up.
 */
export async function appUninstalledHandler(
  webhookId: string,
  shopDomain: string,
  env: Env,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  const result = await env.DB.prepare(
    `UPDATE shops SET uninstalled_at = ? WHERE shopify_domain = ? AND uninstalled_at IS NULL`,
  )
    .bind(now, shopDomain)
    .run();

  if (result.meta?.changes === 0) {
    log('warn', 'app/uninstalled: shop not found or already marked uninstalled', {
      shop: shopDomain,
    });
    return;
  }

  log('info', 'app/uninstalled: shop marked uninstalled', { shop: shopDomain });

  const shopRow = await env.DB.prepare(
    `SELECT id FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ id: number }>();

  await insertGdprRequest(env.DB, {
    id: webhookId || `app-uninstall-${shopDomain}-${now}`,
    shop_id: shopRow?.id ?? null,
    shop_domain: shopDomain,
    kind: 'app_uninstall_purge',
    shopify_customer_id: null,
    payload_json: '{}',
    received_at: now,
    due_at: dueAtFor('app_uninstall_purge', now),
  });

  log('info', 'app/uninstalled: deferred purge scheduled', {
    shop: shopDomain,
    due_in_days: APP_UNINSTALL_PURGE_GRACE_S / 86400,
  });
}
