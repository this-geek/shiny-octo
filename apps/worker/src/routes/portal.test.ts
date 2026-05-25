import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { appProxyRouter } from './app-proxy.js';
import { encrypt } from '../lib/crypto.js';
import type { Env } from '../types.js';

const SECRET = 'app-proxy-secret-portal';
const MASTER_KEY = '00'.repeat(32);
const SHOP_DOMAIN = 'demo.myshopify.com';
const COMPANY_ID = 'gid://shopify/Company/9001';
const CUSTOMER_ID = 'gid://shopify/Customer/42';

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
  store: Map<string, string>;
  get: (k: string) => Promise<string | null>;
  put: (k: string, v: string, opts?: { expirationTtl?: number }) => Promise<void>;
}

function makeKV(): MockKV {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
  };
}

interface MockKVWithDelete extends MockKV {
  delete: (k: string) => Promise<void>;
}

function makeKVSessions(): MockKVWithDelete {
  const kv = makeKV();
  return { ...kv, async delete(k: string) { kv.store.delete(k); } };
}

interface ShopRow {
  id: number;
  shopify_domain: string;
  access_token_encrypted: string;
}

function makeEnv(opts: {
  shop?: ShopRow;
  companyForCustomer?: string | null;
  mappedTierId?: number | null;
  assets?: Array<Record<string, unknown>>;
  kvSessions?: MockKVWithDelete;
}): { env: Env; kvSessions: MockKVWithDelete } {
  const kv = makeKV();
  const kvSessions = opts.kvSessions ?? makeKVSessions();
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
            if (opts.mappedTierId == null) return null;
            return { tier_id: opts.mappedTierId } as unknown as T;
          }
          return null;
        },
        async run(): Promise<D1Result> {
          return { success: true, meta: { changes: 0 } } as unknown as D1Result;
        },
        async all<T>(): Promise<D1Result<T>> {
          if (sql.includes('FROM assets')) {
            return {
              results: (opts.assets ?? []) as unknown as T[],
              success: true,
              meta: {},
            } as unknown as D1Result<T>;
          }
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
    KV_SESSIONS: kvSessions as unknown as KVNamespace,
    KV_IDEMPOTENCY: {} as KVNamespace,
    KV_HOT_CACHE: kv as unknown as KVNamespace,
    ASSETS_BUCKET: {} as R2Bucket,
    WEBHOOK_QUEUE: {} as Queue,
    SHOPIFY_API_KEY: 'k',
    SHOPIFY_API_SECRET: SECRET,
    MASTER_KEY: MASTER_KEY,
    RESEND_API_KEY: '',
    APP_URL: 'https://w.example.com',
    SHOPIFY_API_VERSION: '2026-04',
    ADMIN_ORIGIN: '',
  };
  return { env, kvSessions };
}

function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/proxy', appProxyRouter);
  return app;
}

async function buildSignedUrl(extra: Record<string, string>): Promise<string> {
  return buildSignedUrlForPath('/proxy/portal', extra);
}

async function buildSignedUrlForPath(
  path: string,
  extra: Record<string, string>,
): Promise<string> {
  const params = { shop: SHOP_DOMAIN, timestamp: '1700000000', ...extra };
  const sig = await signProxy(params, SECRET);
  const qs = new URLSearchParams({ ...params, signature: sig });
  return `${path}?${qs.toString()}`;
}

function stubCustomerCompanyLookup(companyId: string | null): void {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        data: {
          customer: companyId
            ? { companyContactProfiles: [{ company: { id: companyId } }] }
            : { companyContactProfiles: [] },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

describe('GET /proxy/portal', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('401 when App Proxy signature is invalid', async () => {
    const { env } = makeEnv({});
    const app = buildApp();
    const res = await app.request(
      '/proxy/portal?shop=demo.myshopify.com&signature=deadbeef',
      {},
      env,
    );
    expect(res.status).toBe(401);
  });

  it('renders a sign-in page (401) when logged_in_customer_id is absent', async () => {
    const { env } = makeEnv({});
    const app = buildApp();
    const url = await buildSignedUrl({});
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Sign in');
    expect(body).toContain(`https://${SHOP_DOMAIN}/account/login`);
  });

  it('renders the "not wholesale" page (403) when the customer has no company', async () => {
    const encryptedToken = await encrypt('shpat_test', SHOP_DOMAIN, MASTER_KEY);
    const { env } = makeEnv({
      shop: { id: 7, shopify_domain: SHOP_DOMAIN, access_token_encrypted: encryptedToken },
      companyForCustomer: null,
    });
    stubCustomerCompanyLookup(null);

    const app = buildApp();
    const url = await buildSignedUrl({ logged_in_customer_id: CUSTOMER_ID });
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('not enabled for this account');
  });

  it('404 when the shop row is missing', async () => {
    const { env } = makeEnv({});
    const app = buildApp();
    const url = await buildSignedUrl({ logged_in_customer_id: CUSTOMER_ID });
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(404);
  });

  it('renders the portal shell (200) for a B2B buyer with company + tier', async () => {
    const encryptedToken = await encrypt('shpat_test', SHOP_DOMAIN, MASTER_KEY);
    const { env } = makeEnv({
      shop: { id: 7, shopify_domain: SHOP_DOMAIN, access_token_encrypted: encryptedToken },
      companyForCustomer: COMPANY_ID,
      mappedTierId: 3,
    });
    stubCustomerCompanyLookup(COMPANY_ID);

    const app = buildApp();
    const url = await buildSignedUrl({ logged_in_customer_id: CUSTOMER_ID });
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Dealer portal');
    expect(body).toContain('b2b-portal-root');
    expect(body).toContain('b2b-portal-boot');
    expect(body).toContain(COMPANY_ID);
    expect(body).toContain('"tier_id":3');
  });

  it('sets security headers (CSP, noindex, no-store) on the shell response', async () => {
    const encryptedToken = await encrypt('shpat_test', SHOP_DOMAIN, MASTER_KEY);
    const { env } = makeEnv({
      shop: { id: 7, shopify_domain: SHOP_DOMAIN, access_token_encrypted: encryptedToken },
      companyForCustomer: COMPANY_ID,
      mappedTierId: null,
    });
    stubCustomerCompanyLookup(COMPANY_ID);

    const app = buildApp();
    const url = await buildSignedUrl({ logged_in_customer_id: CUSTOMER_ID });
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toMatch(/default-src 'self'/);
    expect(res.headers.get('X-Robots-Tag')).toMatch(/noindex/);
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('escapes shop_domain when rendering the login link', async () => {
    const { env } = makeEnv({});
    const app = buildApp();
    // Sign a URL where the shop param contains a quote — the response must HTML-escape it.
    const params = { shop: 'demo".myshopify.com', timestamp: '1700000000' };
    const sig = await signProxy(params, SECRET);
    const qs = new URLSearchParams({ ...params, signature: sig });
    const res = await app.request(`/proxy/portal?${qs.toString()}`, {}, env);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain('demo".myshopify.com');
    expect(body).toContain('demo&quot;.myshopify.com');
  });
});

describe('/proxy/portal/api/*', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('GET /api/assets/list — 401 when logged_in_customer_id is absent', async () => {
    const { env } = makeEnv({});
    const app = buildApp();
    const url = await buildSignedUrlForPath('/proxy/portal/api/assets/list', {});
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: 'login required' });
  });

  it('GET /api/assets/list — 401 when App Proxy signature is invalid', async () => {
    const { env } = makeEnv({});
    const app = buildApp();
    const res = await app.request(
      '/proxy/portal/api/assets/list?shop=demo.myshopify.com&signature=deadbeef',
      {},
      env,
    );
    expect(res.status).toBe(401);
  });

  it('GET /api/assets/list — returns assets:[] for a non-B2B customer', async () => {
    const encryptedToken = await encrypt('shpat_test', SHOP_DOMAIN, MASTER_KEY);
    const { env } = makeEnv({
      shop: { id: 7, shopify_domain: SHOP_DOMAIN, access_token_encrypted: encryptedToken },
      companyForCustomer: null,
    });
    stubCustomerCompanyLookup(null);

    const app = buildApp();
    const url = await buildSignedUrlForPath('/proxy/portal/api/assets/list', {
      logged_in_customer_id: CUSTOMER_ID,
    });
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ assets: [] });
  });

  it('GET /api/tour-status — returns Day-1 features + Day-2 teasers for a B2B buyer', async () => {
    const encryptedToken = await encrypt('shpat_test', SHOP_DOMAIN, MASTER_KEY);
    const { env } = makeEnv({
      shop: { id: 7, shopify_domain: SHOP_DOMAIN, access_token_encrypted: encryptedToken },
      companyForCustomer: COMPANY_ID,
      mappedTierId: 3,
    });
    stubCustomerCompanyLookup(COMPANY_ID);

    const app = buildApp();
    const url = await buildSignedUrlForPath('/proxy/portal/api/tour-status', {
      logged_in_customer_id: CUSTOMER_ID,
    });
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      show_tour: boolean;
      day1_features: Array<{ id: string }>;
      day2_teasers: Array<{ id: string }>;
    };
    expect(json.show_tour).toBe(true);
    expect(json.day1_features.map(f => f.id)).toEqual(['assets', 'profile', 'pricing']);
    expect(json.day2_teasers.map(f => f.id)).toEqual(['quick_order', 'saved_lists', 'quotes']);
  });

  it('POST /api/tour-dismiss — writes dismissal flag to KV_SESSIONS', async () => {
    const encryptedToken = await encrypt('shpat_test', SHOP_DOMAIN, MASTER_KEY);
    const kvSessions = makeKVSessions();
    const { env } = makeEnv({
      shop: { id: 7, shopify_domain: SHOP_DOMAIN, access_token_encrypted: encryptedToken },
      companyForCustomer: COMPANY_ID,
      mappedTierId: 3,
      kvSessions,
    });
    stubCustomerCompanyLookup(COMPANY_ID);

    const app = buildApp();
    const url = await buildSignedUrlForPath('/proxy/portal/api/tour-dismiss', {
      logged_in_customer_id: CUSTOMER_ID,
    });
    const res = await app.request(url, { method: 'POST' }, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ dismissed: true });
    const stored = Array.from(kvSessions.store.keys());
    expect(stored.length).toBe(1);
    expect(stored[0]).toMatch(/^tour:7:/);
  });

  it('GET /api/tour-status — show_tour is false after dismissal', async () => {
    const encryptedToken = await encrypt('shpat_test', SHOP_DOMAIN, MASTER_KEY);
    const kvSessions = makeKVSessions();
    const { env } = makeEnv({
      shop: { id: 7, shopify_domain: SHOP_DOMAIN, access_token_encrypted: encryptedToken },
      companyForCustomer: COMPANY_ID,
      mappedTierId: 3,
      kvSessions,
    });
    // Two stubbed calls — one per request (the KV_HOT_CACHE entry from the first
    // resolve persists across calls in this mock, but the company lookup is only
    // invoked when the cache misses, so re-stub defensively).
    stubCustomerCompanyLookup(COMPANY_ID);
    stubCustomerCompanyLookup(COMPANY_ID);

    const app = buildApp();
    const dismissUrl = await buildSignedUrlForPath('/proxy/portal/api/tour-dismiss', {
      logged_in_customer_id: CUSTOMER_ID,
    });
    await app.request(dismissUrl, { method: 'POST' }, env);

    const statusUrl = await buildSignedUrlForPath('/proxy/portal/api/tour-status', {
      logged_in_customer_id: CUSTOMER_ID,
    });
    const res = await app.request(statusUrl, {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { show_tour: boolean };
    expect(json.show_tour).toBe(false);
  });

  it('GET /api/assets/download/:id — 401 when logged_in_customer_id is absent', async () => {
    const { env } = makeEnv({});
    const app = buildApp();
    const url = await buildSignedUrlForPath('/proxy/portal/api/assets/download/abc123', {});
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(401);
  });
});
