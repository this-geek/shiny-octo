import { Hono } from 'hono';
import type { Env } from '../types.js';
import { webhookHmacMiddleware } from '../middleware/webhook-hmac.js';
import { appUninstalledHandler } from '../handlers/app-uninstalled.js';
import { shopUpdateHandler } from '../handlers/shop-update.js';
import { log } from '../lib/logger.js';

interface WebhookQueueMessage {
  id: string;
  topic: string;
  shop_domain: string;
  body: string;
}

export const webhooksRouter = new Hono<{ Bindings: Env }>();

// Apply HMAC verification middleware to all webhook routes
webhooksRouter.use('*', webhookHmacMiddleware);

/**
 * POST /webhooks
 * Receives all Shopify webhooks, verifies HMAC, deduplicates by webhook ID,
 * enqueues for async processing, and logs receipt.
 */
webhooksRouter.post('/', async c => {
  const webhookId = c.req.header('X-Shopify-Webhook-Id') ?? '';
  const topic = c.req.header('X-Shopify-Topic') ?? '';
  const shopDomain = c.req.header('X-Shopify-Shop-Domain') ?? '';

  if (!webhookId || !topic || !shopDomain) {
    log('warn', 'Webhook missing required headers', { topic, shop: shopDomain });
    return c.text('Bad Request', 400);
  }

  const idempotencyKey = `webhook:${webhookId}`;

  // Check for duplicate delivery
  const existing = await c.env.KV_IDEMPOTENCY.get(idempotencyKey);
  if (existing) {
    log('info', 'Duplicate webhook received — skipping', { topic, shop: shopDomain, id: webhookId });
    return c.text('OK', 200);
  }

  // Read raw body as text (HMAC was already verified against the raw bytes)
  const bodyText = await c.req.text();

  // Look up shop_id from D1 for logging
  const shopRow = await c.env.DB.prepare(
    `SELECT id FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ id: number }>();

  const shopId = shopRow?.id;

  // Enqueue for async processing
  const message: WebhookQueueMessage = {
    id: webhookId,
    topic,
    shop_domain: shopDomain,
    body: bodyText,
  };

  await c.env.WEBHOOK_QUEUE.send(message);

  // Mark as received in idempotency KV (48h TTL = 172800 seconds)
  await c.env.KV_IDEMPOTENCY.put(idempotencyKey, '1', { expirationTtl: 172800 });

  // Log receipt in D1 webhook_log
  const now = Math.floor(Date.now() / 1000);
  if (shopId) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO webhook_log (id, shop_id, topic, received_at, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    )
      .bind(webhookId, shopId, topic, now)
      .run();
  }

  log('info', 'Webhook received and enqueued', { topic, shop_id: shopId, id: webhookId });

  return c.text('OK', 200);
});

/**
 * Queue consumer: dispatches webhook messages to topic-specific handlers.
 * Called from the Worker's `queue` export.
 */
export async function handleWebhookQueue(
  batch: MessageBatch<WebhookQueueMessage>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    const { id, topic, shop_domain, body } = msg.body;

    log('info', 'Processing webhook from queue', { topic, shop: shop_domain, id });

    try {
      await dispatchWebhook(topic, shop_domain, body, env);

      // Update webhook_log status to 'processed'
      const shopRow = await env.DB.prepare(
        `SELECT id FROM shops WHERE shopify_domain = ?`,
      )
        .bind(shop_domain)
        .first<{ id: number }>();

      if (shopRow) {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
          `UPDATE webhook_log SET status = 'processed', processed_at = ? WHERE id = ?`,
        )
          .bind(now, id)
          .run();
      }

      msg.ack();
    } catch (err) {
      log('error', 'Webhook handler failed', {
        topic,
        shop: shop_domain,
        id,
        error: String(err),
      });
      msg.retry();
    }
  }
}

async function dispatchWebhook(
  topic: string,
  shopDomain: string,
  _body: string,
  env: Env,
): Promise<void> {
  switch (topic) {
    case 'app/uninstalled':
      await appUninstalledHandler(shopDomain, env);
      break;

    case 'shop/update':
      await shopUpdateHandler(shopDomain, env);
      break;

    // GDPR mandatory endpoints — Phase 1 will implement full PII purge
    case 'customers/data_request':
      log('info', 'GDPR data request received — Phase 1 implementation pending', {
        shop: shopDomain,
      });
      break;

    case 'customers/redact':
      log('info', 'GDPR customer redact received — Phase 1 implementation pending', {
        shop: shopDomain,
      });
      break;

    case 'shop/redact':
      log('info', 'GDPR shop redact received — Phase 1 implementation pending', {
        shop: shopDomain,
      });
      break;

    // Company events — Phase 1 will sync to D1 hot cache
    case 'companies/create':
    case 'companies/update':
    case 'companies/delete':
    case 'company_locations/create':
    case 'company_locations/update':
      log('info', `Company event received — cache invalidation Phase 1`, {
        topic,
        shop: shopDomain,
      });
      break;

    // Order events — Phase 2 analytics
    case 'orders/create':
    case 'orders/updated':
    case 'orders/cancelled':
      log('info', 'Order event received', { topic, shop: shopDomain });
      break;

    // Customer events — Phase 1 registration flow
    case 'customers/create':
    case 'customers/update':
      log('info', 'Customer event received', { topic, shop: shopDomain });
      break;

    case 'app/scopes_update':
      log('info', 'App scopes updated', { shop: shopDomain });
      break;

    default:
      log('warn', 'Unhandled webhook topic', { topic, shop: shopDomain });
  }
}
