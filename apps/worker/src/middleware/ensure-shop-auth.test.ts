import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { ensureShopAuthMiddleware } from './ensure-shop-auth.js';
import { encrypt } from '../lib/crypto.js';

const SHOP = 'demo.myshopify.com';
const MASTER_KEY = '00'.repeat(32);

interface ShopRow {
  id: number;
  shopify_domain: string;
  access_token_encrypted: string;
  uninstalled_at: number | null;
}

function makeDB(rows: ShopRow[]): D1Database {
  let nextId = (rows[rows.length - 1]?.id ?? 0) + 1;
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM shops') && sql.includes('uninstalled_at IS NULL')) {
            const domain = bound[0] as string;
            const hit = rows.find(r => r.shopify_domain === domain && r.uninstalled_at == null);
            return hit ? ({ id: hit.id, access_token_encrypted: hit.access_token_encrypted } as unknown as T) : null;
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO shops')) {
            const [shopify_domain, , access_token_encrypted] = bound as [
              string,
              number,
              string,
            ];
            const existing = rows.find(r => r.shopify_domain === shopify_domain);
            if (existing) {
              existing.access_token_encrypted = access_token_encrypted;
              existing.uninstalled_at = null;
            } else {
              rows.push({
                id: nextId++,
                shopify_domain,
                access_token_encrypted,
                uninstalled_at: null,
              });
            }
          }
          return { success: true, meta: { changes: 1 } } as unknown as D1Result;
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function makeEnv(rows: ShopRow[]): Env {
  return {
    DB: makeDB(rows),
    KV_SESSIONS: {} as KVNamespace,
    KV_IDEMPOTENCY: {} as KVNamespace,
    KV_HOT_CACHE: {} as KVNamespace,
    ASSETS_BUCKET: {} as R2Bucket,
    WEBHOOK_QUEUE: {} as Queue,
    SHOPIFY_API_KEY: 'api-key',
    SHOPIFY_API_SECRET: 'api-secret',
    MASTER_KEY,
    RESEND_API_KEY: '',
    APP_URL: 'https://example.test',
    SHOPIFY_API_VERSION: '2026-04',
    ADMIN_ORIGIN: 'https://admin.shopify.com',
  };
}

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('shopDomain', SHOP);
    c.set('sessionToken', 'session-jwt');
    return next();
  });
  app.use('*', ensureShopAuthMiddleware);
  app.get('/admin/ping', c => c.json({ ok: true }));
  return (path: string) =>
    app.fetch(new Request(`http://x${path}`), env);
}

describe('ensureShopAuthMiddleware', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('no-ops and passes through when a shop row already exists', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const rows: ShopRow[] = [
      {
        id: 1,
        shopify_domain: SHOP,
        access_token_encrypted: await encrypt('shpat_existing', SHOP, MASTER_KEY),
        uninstalled_at: null,
      },
    ];
    const env = makeEnv(rows);
    const call = makeApp(env);

    const res = await call('/admin/ping');
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls token-exchange and inserts a shop row when none exists', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // 1. token exchange
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'shpat_new_offline' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // 2. fetchShopPlan
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { shop: { id: 'gid://shopify/Shop/42', plan: { shopifyPlus: false } } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    // 3+ ensureMetafieldDefinitions + setShopMetafield calls — return 200 for all.
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const rows: ShopRow[] = [];
    const env = makeEnv(rows);
    const call = makeApp(env);

    const res = await call('/admin/ping');
    expect(res.status).toBe(200);

    const exchangeCall = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(exchangeCall[0]).toBe(`https://${SHOP}/admin/oauth/access_token`);
    const body = JSON.parse(exchangeCall[1].body as string) as Record<string, string>;
    expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.subject_token).toBe('session-jwt');

    expect(rows).toHaveLength(1);
    expect(rows[0].shopify_domain).toBe(SHOP);
    expect(rows[0].access_token_encrypted).not.toBe('');
  });

  it('returns 500 when token-exchange fails', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }));

    const env = makeEnv([]);
    const call = makeApp(env);
    const res = await call('/admin/ping');
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/shop auth unavailable/);
  });
});
