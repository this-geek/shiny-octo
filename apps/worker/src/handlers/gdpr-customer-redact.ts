/**
 * Webhook handler for Shopify's `customers/redact` topic.
 *
 * Records the request with a 7-day stand-down `due_at`. The sweep does the
 * actual purge. Shopify already holds this webhook for 10 days after the
 * buyer's request, so total latency is ~17 days — still well inside the
 * 30-day legal deadline.
 *
 * Shopify schema:
 *   { shop_id, shop_domain, customer{id,email,phone}, orders_to_redact[] }
 */

import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import { dueAtFor, insertGdprRequest } from '../lib/gdpr-store.js';

interface ShopifyRedactPayload {
  shop_id?: number;
  shop_domain?: string;
  customer?: { id?: number | string };
}

export async function gdprCustomerRedactHandler(
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
    kind: 'customer_redact',
    shopify_customer_id: customerId,
    payload_json: body,
    received_at: now,
    due_at: dueAtFor('customer_redact', now),
  });

  log('info', 'gdpr: customer_redact queued (7-day stand-down)', {
    shop: shopDomain,
    webhook_id: webhookId,
    customer_present: customerId !== null,
  });
}

function parsePayload(body: string): ShopifyRedactPayload {
  try {
    return JSON.parse(body) as ShopifyRedactPayload;
  } catch {
    return {};
  }
}
