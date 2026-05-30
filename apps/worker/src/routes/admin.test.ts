import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminRouter } from './admin.js';
import type { Env } from '../types.js';
import { encrypt } from '../lib/crypto.js';

const API_KEY = 'test-api-key';
const API_SECRET = 'test-api-secret';
const SHOP_DOMAIN = 'demo.myshopify.com';
const MASTER_KEY = '00'.repeat(32);

interface ShopRow {
  is_plus: number;
  plus_banner_dismissed_at: number | null;
  settings_json?: string;
  exists?: boolean;
}

function makeEnv(initial: ShopRow): { env: Env; state: { row: ShopRow } } {
  const state: { row: ShopRow } = {
    row: { settings_json: '{}', exists: true, ...initial },
  };

  const db: D1Database = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...args: unknown[]): D1PreparedStatement {
          bound = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('access_token_encrypted') && sql.includes('uninstalled_at IS NULL')) {
            const enc = await encrypt('shpat_FAKE', SHOP_DOMAIN, MASTER_KEY);
            return { id: 1, access_token_encrypted: enc } as unknown as T;
          }
          if (sql.includes('SELECT settings_json')) {
            if (state.row.exists === false) return null;
            return { settings_json: state.row.settings_json ?? '{}' } as unknown as T;
          }
          if (sql.includes('SELECT')) {
            return {
              is_plus: state.row.is_plus,
              plus_banner_dismissed_at: state.row.plus_banner_dismissed_at,
            } as unknown as T;
          }
          return null;
        },
        async run(): Promise<D1Result> {
          if (sql.includes('UPDATE shops SET plus_banner_dismissed_at')) {
            state.row.plus_banner_dismissed_at = bound[0] as number;
          }
          if (sql.includes('UPDATE shops SET settings_json')) {
            state.row.settings_json = bound[0] as string;
          }
          return { success: true, meta: { changes: 1 } } as unknown as D1Result;
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
    KV_HOT_CACHE: {} as KVNamespace,
    ASSETS_BUCKET: {} as R2Bucket,
    WEBHOOK_QUEUE: {} as Queue,
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    MASTER_KEY,
    RESEND_API_KEY: '',
    APP_URL: 'https://worker.example.com',
    SHOPIFY_API_VERSION: '2026-04',
    ADMIN_ORIGIN: '',
  };

  return { env, state };
}

async function makeSessionToken(secret: string, claims: Record<string, unknown>): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  const headerB64 = enc(header);
  const payloadB64 = enc(claims);
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `${signingInput}.${sigB64}`;
}

function validClaims(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `https://${SHOP_DOMAIN}/admin`,
    dest: `https://${SHOP_DOMAIN}`,
    aud: API_KEY,
    sub: 'user-123',
    exp: now + 300,
    nbf: now - 10,
    iat: now,
    jti: 'jti-1',
    sid: 'sid-1',
  };
}

function buildApp(env: Env): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/admin', adminRouter);
  app.notFound(c => c.text('not found', 404));
  // Inject env into all requests
  app.use('*', async (c, next) => {
    Object.assign(c.env, env);
    await next();
  });
  return app;
}

describe('GET /admin/shop-status', () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv({ is_plus: 1, plus_banner_dismissed_at: null }).env;
  });

  it('401 without Authorization header', async () => {
    const app = buildApp(env);
    const res = await app.request('/admin/shop-status', {}, env);
    expect(res.status).toBe(401);
  });

  it('401 with malformed token', async () => {
    const app = buildApp(env);
    const res = await app.request(
      '/admin/shop-status',
      { headers: { Authorization: 'Bearer not.a.jwt' } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns is_plus, plus_banner_dismissed, shop_domain with valid token', async () => {
    const app = buildApp(env);
    const token = await makeSessionToken(API_SECRET, validClaims());
    const res = await app.request(
      '/admin/shop-status',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      is_plus: boolean;
      plus_banner_dismissed: boolean;
      shop_domain: string;
    };
    expect(json.is_plus).toBe(true);
    expect(json.plus_banner_dismissed).toBe(false);
    expect(json.shop_domain).toBe(SHOP_DOMAIN);
  });
});

describe('POST /admin/plus-banner/dismiss', () => {
  it('401 without Authorization', async () => {
    const { env } = makeEnv({ is_plus: 1, plus_banner_dismissed_at: null });
    const app = buildApp(env);
    const res = await app.request(
      '/admin/plus-banner/dismiss',
      { method: 'POST' },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('sets plus_banner_dismissed_at and returns ok:true', async () => {
    const { env } = makeEnv({ is_plus: 1, plus_banner_dismissed_at: null });
    const app = buildApp(env);
    const token = await makeSessionToken(API_SECRET, validClaims());

    const res = await app.request(
      '/admin/plus-banner/dismiss',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Second call (idempotent — still ok)
    const res2 = await app.request(
      '/admin/plus-banner/dismiss',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true });
  });
});

describe('GET /admin/settings', () => {
  it('401 without Authorization', async () => {
    const { env } = makeEnv({ is_plus: 0, plus_banner_dismissed_at: null });
    const app = buildApp(env);
    const res = await app.request('/admin/settings', {}, env);
    expect(res.status).toBe(401);
  });

  it('returns empty admin settings when settings_json is empty', async () => {
    const { env } = makeEnv({ is_plus: 0, plus_banner_dismissed_at: null });
    const app = buildApp(env);
    const token = await makeSessionToken(API_SECRET, validClaims());
    const res = await app.request(
      '/admin/settings',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('returns only admin-settings keys, hiding unrelated blob keys', async () => {
    const { env } = makeEnv({
      is_plus: 0,
      plus_banner_dismissed_at: null,
      settings_json: JSON.stringify({
        brand: { primaryColor: '#112233' },
        app_proxy: { subpath: 'apps/b2b' },
      }),
    });
    const app = buildApp(env);
    const token = await makeSessionToken(API_SECRET, validClaims());
    const res = await app.request(
      '/admin/settings',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ brand: { primaryColor: '#112233' } });
  });
});

describe('PUT /admin/settings', () => {
  it('401 without Authorization', async () => {
    const { env } = makeEnv({ is_plus: 0, plus_banner_dismissed_at: null });
    const app = buildApp(env);
    const res = await app.request(
      '/admin/settings',
      { method: 'PUT', body: '{}' },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('rejects invalid hex colour', async () => {
    const { env } = makeEnv({ is_plus: 0, plus_banner_dismissed_at: null });
    const app = buildApp(env);
    const token = await makeSessionToken(API_SECRET, validClaims());
    const res = await app.request(
      '/admin/settings',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: { primaryColor: 'red' } }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/primaryColor/);
  });

  it('rejects duplicate field ids', async () => {
    const { env } = makeEnv({ is_plus: 0, plus_banner_dismissed_at: null });
    const app = buildApp(env);
    const token = await makeSessionToken(API_SECRET, validClaims());
    const res = await app.request(
      '/admin/settings',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationForm: {
            requireDocuments: false,
            fields: [
              { id: 'name', label: 'Name', type: 'text', required: true },
              { id: 'name', label: 'Other', type: 'text', required: false },
            ],
          },
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('persists valid patch and shallow-merges with unrelated keys', async () => {
    const { env, state } = makeEnv({
      is_plus: 0,
      plus_banner_dismissed_at: null,
      settings_json: JSON.stringify({ app_proxy: { subpath: 'apps/b2b' } }),
    });
    const app = buildApp(env);
    const token = await makeSessionToken(API_SECRET, validClaims());
    const res = await app.request(
      '/admin/settings',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand: { primaryColor: '#aabbcc', accentColor: '#ddeeff' },
          emailTemplates: {
            approved: { subject: 'Welcome', body: 'You are approved' },
          },
        }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const persisted = JSON.parse(state.row.settings_json ?? '{}');
    expect(persisted.app_proxy).toEqual({ subpath: 'apps/b2b' });
    expect(persisted.brand).toEqual({ primaryColor: '#aabbcc', accentColor: '#ddeeff' });
    expect(persisted.emailTemplates.approved.subject).toBe('Welcome');
  });

  it('404 when the shop does not exist', async () => {
    const { env } = makeEnv({
      is_plus: 0,
      plus_banner_dismissed_at: null,
      exists: false,
    });
    const app = buildApp(env);
    const token = await makeSessionToken(API_SECRET, validClaims());
    const res = await app.request(
      '/admin/settings',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: { primaryColor: '#000000' } }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('rejects an invalid priceDisplay.mode', async () => {
    const { env } = makeEnv({ is_plus: 0, plus_banner_dismissed_at: null });
    const app = buildApp(env);
    const token = await makeSessionToken(API_SECRET, validClaims());
    const res = await app.request(
      '/admin/settings',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceDisplay: { siteWide: true, mode: 'hide', showSavingsBadge: true },
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/priceDisplay\.mode/);
  });

  it('persists priceDisplay and enqueues the metafield publish', async () => {
    const { env, state } = makeEnv({ is_plus: 0, plus_banner_dismissed_at: null });
    const sent: unknown[] = [];
    env.WEBHOOK_QUEUE = { send: async (m: unknown) => void sent.push(m) } as unknown as Queue;
    const app = buildApp(env);
    const token = await makeSessionToken(API_SECRET, validClaims());
    const res = await app.request(
      '/admin/settings',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceDisplay: { siteWide: true, mode: 'replace', showSavingsBadge: false },
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const persisted = JSON.parse(state.row.settings_json ?? '{}');
    expect(persisted.priceDisplay).toEqual({
      siteWide: true,
      mode: 'replace',
      showSavingsBadge: false,
    });
    expect(sent).toHaveLength(1);
    expect((sent[0] as { topic: string }).topic).toBe('_internal/publish-price-display');
  });

  it('does not enqueue a publish when the patch leaves priceDisplay untouched', async () => {
    const { env } = makeEnv({ is_plus: 0, plus_banner_dismissed_at: null });
    const sent: unknown[] = [];
    env.WEBHOOK_QUEUE = { send: async (m: unknown) => void sent.push(m) } as unknown as Queue;
    const app = buildApp(env);
    const token = await makeSessionToken(API_SECRET, validClaims());
    const res = await app.request(
      '/admin/settings',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: { primaryColor: '#112233', accentColor: '#445566' } }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});
