import { Hono } from 'hono';
import type { Env } from '../types.js';
import { webhookHmacMiddleware } from '../middleware/webhook-hmac.js';
import { appUninstalledHandler } from '../handlers/app-uninstalled.js';
import { shopUpdateHandler } from '../handlers/shop-update.js';
import { publishTiersConfigHandler } from '../handlers/publish-tiers-config.js';
import {
  mirrorCompanyTierHandler,
  type MirrorCompanyTierPayload,
} from '../handlers/mirror-company-tier.js';
import {
  sendApplicationEmailHandler,
  type SendApplicationEmailPayload,
} from '../handlers/send-application-email.js';
import { gdprDataRequestHandler } from '../handlers/gdpr-data-request.js';
import { gdprCustomerRedactHandler } from '../handlers/gdpr-customer-redact.js';
import { gdprShopRedactHandler } from '../handlers/gdpr-shop-redact.js';
import {
  sendGdprExportHandler,
  type SendGdprExportPayload,
} from '../handlers/send-gdpr-export.js';
import { log } from '../lib/logger.js';

export const INTERNAL_PUBLISH_TIERS_CONFIG = '_internal/publish-tiers-config';
export const INTERNAL_MIRROR_COMPANY_TIER = '_internal/mirror-company-tier';
export const INTERNAL_SEND_APPLICATION_EMAIL = '_internal/send-application-email';
export const INTERNAL_SEND_GDPR_EXPORT = '_internal/send-gdpr-export';

interface WebhookQueueMessage {
  id: string;
  topic: string;
  shop_domain: string;
  body: string;
}

/**
 * Pull a shop domain out of a webhook JSON body if one is present.
 * Shopify shop/app webhooks carry `myshopify_domain`; GDPR webhooks carry
 * `shop_domain`. Returns null when the body is unparseable or has no such
 * field — those topics are dispatched by header alone.
 */
function extractBodyShopDomain(bodyText: string): string | null {
  if (!bodyText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const myshopify = obj.myshopify_domain;
  if (typeof myshopify === 'string' && myshopify.length > 0) return myshopify;
  const shop_domain = obj.shop_domain;
  if (typeof shop_domain === 'string' && shop_domain.length > 0) return shop_domain;
  return null;
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

  // Internal queue topics MUST NOT be accepted from the public endpoint —
  // only same-process code (lib/internal-jobs.ts) is allowed to enqueue them.
  if (topic.startsWith('_internal/')) {
    log('warn', 'Refusing _internal topic on public webhook endpoint', { topic, shop: shopDomain });
    return c.text('Forbidden', 403);
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

  // Shopify's HMAC only covers the body, not the X-Shopify-Shop-Domain header.
  // If the body carries an unambiguous shop identifier, require it to match
  // the header — otherwise a captured (body, hmac) pair could be replayed with
  // a swapped header to drive state-mutating handlers (e.g. app/uninstalled)
  // against a different installed shop.
  const bodyShop = extractBodyShopDomain(bodyText);
  if (bodyShop && bodyShop.toLowerCase() !== shopDomain.toLowerCase()) {
    log('warn', 'Webhook body shop does not match X-Shopify-Shop-Domain header', {
      topic,
      header_shop: shopDomain,
      body_shop: bodyShop,
    });
    return c.text('Unauthorized', 401);
  }

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
      await dispatchWebhook(topic, shop_domain, body, env, id);

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
  body: string,
  env: Env,
  webhookId: string = '',
): Promise<void> {
  switch (topic) {
    case 'app/uninstalled':
      await appUninstalledHandler(webhookId, shopDomain, env);
      break;

    case 'shop/update':
      await shopUpdateHandler(shopDomain, env);
      break;

    case INTERNAL_PUBLISH_TIERS_CONFIG:
      await publishTiersConfigHandler(shopDomain, env);
      break;

    case INTERNAL_MIRROR_COMPANY_TIER:
      await mirrorCompanyTierHandler(
        shopDomain,
        JSON.parse(body) as MirrorCompanyTierPayload,
        env,
      );
      break;

    case INTERNAL_SEND_APPLICATION_EMAIL:
      await sendApplicationEmailHandler(
        shopDomain,
        JSON.parse(body) as SendApplicationEmailPayload,
        env,
      );
      break;

    case INTERNAL_SEND_GDPR_EXPORT:
      await sendGdprExportHandler(
        shopDomain,
        JSON.parse(body) as SendGdprExportPayload,
        env,
      );
      break;

    // GDPR mandatory endpoints. The handler only records the request; the
    // daily cron sweep (`handlers/gdpr-sweep.ts`) performs the actual
    // export/purge after the configured stand-down window.
    case 'customers/data_request':
      await gdprDataRequestHandler(webhookId, shopDomain, body, env);
      break;

    case 'customers/redact':
      await gdprCustomerRedactHandler(webhookId, shopDomain, body, env);
      break;

    case 'shop/redact':
      await gdprShopRedactHandler(webhookId, shopDomain, body, env);
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
