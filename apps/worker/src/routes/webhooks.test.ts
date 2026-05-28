import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { webhooksRouter } from './webhooks.js';
import type { Env } from '../types.js';

const API_SECRET = 'test-webhook-secret';

async function hmacBase64(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(API_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

interface QueuedMessage {
  id: string;
  topic: string;
  shop_domain: string;
  body: string;
}

function makeEnv(): {
  env: Env;
  queue: QueuedMessage[];
  idempotency: Map<string, string>;
} {
  const queue: QueuedMessage[] = [];
  const idempotency = new Map<string, string>();

  const noop = {} as unknown;
  const env: Env = {
    DB: {
      prepare(_sql: string) {
        const stmt = {
          bind() {
            return stmt;
          },
          async first() {
            return null;
          },
          async run() {
            return { success: true, meta: {} };
          },
          async all() {
            return { results: [] };
          },
        };
        return stmt;
      },
    } as unknown as D1Database,
    KV_SESSIONS: noop as KVNamespace,
    KV_IDEMPOTENCY: {
      async get(key: string) {
        return idempotency.get(key) ?? null;
      },
      async put(key: string, value: string) {
        idempotency.set(key, value);
      },
      async delete(key: string) {
        idempotency.delete(key);
      },
    } as unknown as KVNamespace,
    KV_HOT_CACHE: noop as KVNamespace,
    ASSETS_BUCKET: noop as R2Bucket,
    WEBHOOK_QUEUE: {
      async send(msg: QueuedMessage) {
        queue.push(msg);
      },
    } as unknown as Queue,
    SHOPIFY_API_KEY: 'test-api-key',
    SHOPIFY_API_SECRET: API_SECRET,
    MASTER_KEY: '00'.repeat(32),
    RESEND_API_KEY: 'resend',
    APP_URL: 'https://app.example.com',
    SHOPIFY_API_VERSION: '2024-10',
    ADMIN_ORIGIN: 'https://admin.example.com',
  };

  return { env, queue, idempotency };
}

function makeApp(env: Env): (init: RequestInit) => Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/webhooks', webhooksRouter);
  return async (init: RequestInit) => app.request('/webhooks', init, env);
}

async function postWebhook(
  request: (init: RequestInit) => Promise<Response>,
  opts: {
    topic: string;
    shopDomain: string;
    body: object | string;
    webhookId?: string;
    overrideSignatureBody?: string;
  },
): Promise<Response> {
  const bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  const sig = await hmacBase64(opts.overrideSignatureBody ?? bodyStr);
  return request({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': sig,
      'X-Shopify-Topic': opts.topic,
      'X-Shopify-Shop-Domain': opts.shopDomain,
      'X-Shopify-Webhook-Id': opts.webhookId ?? `wh-${Math.random().toString(36).slice(2)}`,
    },
    body: bodyStr,
  });
}

describe('POST /webhooks — baseline', () => {
  let env: Env;
  let queue: QueuedMessage[];
  let request: (init: RequestInit) => Promise<Response>;

  beforeEach(() => {
    const made = makeEnv();
    env = made.env;
    queue = made.queue;
    request = makeApp(env);
  });

  it('accepts a webhook whose body myshopify_domain matches the header', async () => {
    const res = await postWebhook(request, {
      topic: 'app/uninstalled',
      shopDomain: 'demo.myshopify.com',
      body: { id: 1, myshopify_domain: 'demo.myshopify.com' },
    });
    expect(res.status).toBe(200);
    expect(queue.length).toBe(1);
    expect(queue[0].topic).toBe('app/uninstalled');
    expect(queue[0].shop_domain).toBe('demo.myshopify.com');
  });

  it('accepts a body with no shop-identifying field (orders/create)', async () => {
    const res = await postWebhook(request, {
      topic: 'orders/create',
      shopDomain: 'demo.myshopify.com',
      body: { id: 9999, line_items: [] },
    });
    expect(res.status).toBe(200);
    expect(queue.length).toBe(1);
  });
});

describe('POST /webhooks — internal topic rejection (#45)', () => {
  let request: (init: RequestInit) => Promise<Response>;
  let queue: QueuedMessage[];

  beforeEach(() => {
    const made = makeEnv();
    queue = made.queue;
    request = makeApp(made.env);
  });

  it('rejects _internal/publish-tiers-config from the public endpoint', async () => {
    const res = await postWebhook(request, {
      topic: '_internal/publish-tiers-config',
      shopDomain: 'demo.myshopify.com',
      body: {},
    });
    expect(res.status).toBe(403);
    expect(queue.length).toBe(0);
  });

  it('rejects _internal/send-application-email from the public endpoint', async () => {
    const res = await postWebhook(request, {
      topic: '_internal/send-application-email',
      shopDomain: 'demo.myshopify.com',
      body: { application_id: 1, kind: 'submitted' },
    });
    expect(res.status).toBe(403);
    expect(queue.length).toBe(0);
  });

  it('rejects any topic beginning with _internal/', async () => {
    const res = await postWebhook(request, {
      topic: '_internal/anything-goes',
      shopDomain: 'demo.myshopify.com',
      body: {},
    });
    expect(res.status).toBe(403);
    expect(queue.length).toBe(0);
  });
});

describe('POST /webhooks — body/header shop cross-check (#32)', () => {
  let request: (init: RequestInit) => Promise<Response>;
  let queue: QueuedMessage[];

  beforeEach(() => {
    const made = makeEnv();
    queue = made.queue;
    request = makeApp(made.env);
  });

  it('rejects app/uninstalled when body.myshopify_domain disagrees with header', async () => {
    const res = await postWebhook(request, {
      topic: 'app/uninstalled',
      shopDomain: 'victim.myshopify.com',
      body: { id: 1, myshopify_domain: 'attacker.myshopify.com' },
    });
    expect(res.status).toBe(401);
    expect(queue.length).toBe(0);
  });

  it('rejects shop/update when body.myshopify_domain disagrees with header', async () => {
    const res = await postWebhook(request, {
      topic: 'shop/update',
      shopDomain: 'victim.myshopify.com',
      body: { id: 5, myshopify_domain: 'attacker.myshopify.com', name: 'X' },
    });
    expect(res.status).toBe(401);
    expect(queue.length).toBe(0);
  });

  it('rejects shop/redact when body.shop_domain disagrees with header', async () => {
    const res = await postWebhook(request, {
      topic: 'shop/redact',
      shopDomain: 'victim.myshopify.com',
      body: { shop_id: 1, shop_domain: 'attacker.myshopify.com' },
    });
    expect(res.status).toBe(401);
    expect(queue.length).toBe(0);
  });

  it('rejects customers/redact when body.shop_domain disagrees with header', async () => {
    const res = await postWebhook(request, {
      topic: 'customers/redact',
      shopDomain: 'victim.myshopify.com',
      body: {
        shop_id: 1,
        shop_domain: 'attacker.myshopify.com',
        customer: { id: 999 },
      },
    });
    expect(res.status).toBe(401);
    expect(queue.length).toBe(0);
  });

  it('accepts shop/redact when body.shop_domain matches the header', async () => {
    const res = await postWebhook(request, {
      topic: 'shop/redact',
      shopDomain: 'demo.myshopify.com',
      body: { shop_id: 1, shop_domain: 'demo.myshopify.com' },
    });
    expect(res.status).toBe(200);
    expect(queue.length).toBe(1);
  });

  it('treats the body/header check case-insensitively (Shopify casing varies)', async () => {
    const res = await postWebhook(request, {
      topic: 'app/uninstalled',
      shopDomain: 'Demo.MyShopify.com',
      body: { id: 1, myshopify_domain: 'demo.myshopify.com' },
    });
    expect(res.status).toBe(200);
  });
});
