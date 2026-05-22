import type { Env } from '../types.js';
import { log } from '../lib/logger.js';

/**
 * Handles the app/uninstalled webhook.
 * Soft-marks the shop as uninstalled by setting uninstalled_at.
 * Does NOT delete data immediately — a data-retention sweep runs separately
 * per GDPR and Shopify's mandatory data deletion timeline.
 */
export async function appUninstalledHandler(shopDomain: string, env: Env): Promise<void> {
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

  // TODO Phase 5: enqueue a deferred data-retention job (e.g. to KV or Queue)
  // that schedules purge of R2 assets and D1 PII after the mandatory retention
  // window (currently 30 days per Shopify policy).
}
