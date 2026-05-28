/**
 * Webhook handler for Shopify's `customers/data_request` topic.
 *
 * We do not export inline (the receive layer must 200 OK in 5 s and we have
 * no idea how much data is involved). Instead we insert a row into
 * `gdpr_requests` with a near-term `due_at`; the daily cron picks it up and
 * emails the bundle to the shop owner.
 *
 * Shopify schema:
 *   { shop_id, shop_domain, orders_requested[], customer{id,email,phone},
 *     data_request{id} }
 */

import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import { dueAtFor, insertGdprRequest } from '../lib/gdpr-store.js';

interface ShopifyDataRequestPayload {
  shop_id?: number;
  shop_domain?: string;
  customer?: { id?: number | string };
}

export async function gdprDataRequestHandler(
  webhookId: string,
  shopDomain: string,
  body: string,
  env: Env,
): Promise<void> {
  const payload = parsePayload(body);
  const customerId =
    payload.customer?.id !== undefined ? String(payload.customer.id) : null;

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
    kind: 'customer_data_request',
    shopify_customer_id: customerId,
    payload_json: body,
    received_at: now,
    due_at: dueAtFor('customer_data_request', now),
  });

  log('info', 'gdpr: data_request queued', {
    shop: shopDomain,
    webhook_id: webhookId,
    customer_present: customerId !== null,
  });
}

function parsePayload(body: string): ShopifyDataRequestPayload {
  try {
    return JSON.parse(body) as ShopifyDataRequestPayload;
  } catch {
    return {};
  }
}
