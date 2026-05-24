import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { appProxyRouter } from './app-proxy.js';
import type { Env } from '../types.js';
import { encrypt } from '../lib/crypto.js';

const MASTER_KEY = '00'.repeat(32);

const SECRET = 'app-proxy-secret-2';
const SHOP_DOMAIN = 'demo.myshopify.com';
const COMPANY_ID = 'gid://shopify/Company/9001';

async function signProxy(params: Record<string, string>, secret: string): Promise<string> {
  const sorted = Object.keys(params).sort();
  const message = sorted.map(k => `${k}=${params[k]}`).join('');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

interface MockKV {
  store: Map<string, { value: string; expirationTtl?: number }>;
  get: (k: string) => Promise<string | null>;
  put: (k: string, v: string, opts?: { expirationTtl?: number }) => Promise<void>;
}

function makeKV(): MockKV {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  return {
    store,
    async get(k: string) {
      return store.get(k)?.value ?? null;
    },
    async put(k: string, v: string, opts?: { expirationTtl?: number }) {
      store.set(k, { value: v, expirationTtl: opts?.expirationTtl });
    },
  };
}

interface ShopRow {
  id: number;
  shopify_domain: string;
  access_token_encrypted: string;
}
interface TierRow {
  id: number;
  name: string;
  discount_type: string;
  discount_value: number;
}
interface MappingRow {
  shop_id: number;
  shopify_company_id: string;
  tier_id: number;
}

function makeEnv(opts: {
  shop?: ShopRow;
  mapping?: MappingRow | null;
  tier?: TierRow | null;
  customerLookup?: () => Promise<{ companyId: string | null }>;
}): { env: Env; kv: MockKV; fetchMock: ReturnType<typeof vi.fn> } {
  const kv = makeKV();
  const fetchMock = vi.fn();

  const db: D1Database = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...args: unknown[]): D1PreparedStatement {
          bound = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          void bound;
          if (sql.includes('FROM shops')) {
            return (opts.shop ?? null) as unknown as T | null;
          }
          if (sql.includes('company_tier_mappings')) {
            if (!opts.mapping || !opts.tier) return null;
            return {
              tier_id: opts.tier.id,
              name: opts.tier.name,
              discount_type: opts.tier.discount_type,
              discount_value: opts.tier.discount_value,
            } as unknown as T;
          }
          return null;
        },
        async run(): Promise<D1Result> {
          return { success: true, meta: { changes: 0 } } as unknown as D1Result;
        },
        async all<T>(): Promise<D1Result<T>> {
          return { results: [], success: true, meta: {} } as unknown as D1Result<T>;
        },
        async raw<T>(): Promise<T[]> {
          return [];
        },
      } as unknown as D1PreparedStatement;
      return stmt;
    },
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;

  const env: Env = {
    DB: db,
    KV_SESSIONS: {} as KVNamespace,
    KV_IDEMPOTENCY: {} as KVNamespace,
    KV_HOT_CACHE: kv as unknown as KVNamespace,
    ASSETS_BUCKET: {} as R2Bucket,
    WEBHOOK_QUEUE: {} as Queue,
    SHOPIFY_API_KEY: 'k',
    SHOPIFY_API_SECRET: SECRET,
    // 32 hex bytes (64 chars) — matches the format expected by decrypt(). We won't actually decrypt in these tests because
    // we stub out the access token lookup result.
    MASTER_KEY: MASTER_KEY,
    RESEND_API_KEY: '',
    APP_URL: 'https://w.example.com',
    SHOPIFY_API_VERSION: '2026-04',
    ADMIN_ORIGIN: '',
  };

  return { env, kv, fetchMock };
}

function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/proxy', appProxyRouter);
  return app;
}

describe('GET /proxy/tier-context', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function buildUrl(params: Record<string, string>): Promise<string> {
    const sig = await signProxy(params, SECRET);
    const qs = new URLSearchParams({ ...params, signature: sig });
    return `/proxy/tier-context?${qs.toString()}`;
  }

  it('401 when signature invalid', async () => {
    const { env } = makeEnv({});
    const app = buildApp();
    const res = await app.request(
      '/proxy/tier-context?shop=demo.myshopify.com&signature=deadbeef',
      {},
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns { tier: null, b2b: false } when logged_in_customer_id is absent', async () => {
    const { env } = makeEnv({});
    const app = buildApp();
    const url = await buildUrl({ shop: SHOP_DOMAIN, timestamp: '1700000000' });
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ tier: null, b2b: false });
  });

  it('returns { b2b: true, tier: {...} } when customer has a company with a tier mapping', async () => {
    const encryptedToken = await encrypt('shpat_test', SHOP_DOMAIN, MASTER_KEY);
    const { env } = makeEnv({
      shop: {
        id: 7,
        shopify_domain: SHOP_DOMAIN,
        access_token_encrypted: encryptedToken,
      },
      mapping: { shop_id: 7, shopify_company_id: COMPANY_ID, tier_id: 3 },
      tier: { id: 3, name: 'Gold', discount_type: 'percent', discount_value: 15 },
    });

    // Stub the Admin GraphQL response that maps customer → company
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            customer: {
              companyContactProfiles: [{ company: { id: COMPANY_ID } }],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = buildApp();
    const url = await buildUrl({
      shop: SHOP_DOMAIN,
      timestamp: '1700000000',
      logged_in_customer_id: '12345',
    });
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      b2b: boolean;
      tier: { id: number; name: string; discount_type: string; discount_value: number } | null;
      company_id?: string;
    };
    expect(json.b2b).toBe(true);
    expect(json.tier).toEqual({
      id: 3,
      name: 'Gold',
      discount_type: 'percent',
      discount_value: 15,
    });
    expect(json.company_id).toBe(COMPANY_ID);
  });

  it('returns { b2b: true, tier: null } when customer has a company but no tier mapping', async () => {
    const encryptedToken = await encrypt('shpat_test', SHOP_DOMAIN, MASTER_KEY);
    const { env } = makeEnv({
      shop: { id: 7, shopify_domain: SHOP_DOMAIN, access_token_encrypted: encryptedToken },
      mapping: null,
      tier: null,
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            customer: {
              companyContactProfiles: [{ company: { id: COMPANY_ID } }],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const app = buildApp();
    const url = await buildUrl({
      shop: SHOP_DOMAIN,
      timestamp: '1700000000',
      logged_in_customer_id: '12345',
    });
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { b2b: boolean; tier: unknown; company_id?: string };
    expect(json.b2b).toBe(true);
    expect(json.tier).toBe(null);
    expect(json.company_id).toBe(COMPANY_ID);
  });
});
