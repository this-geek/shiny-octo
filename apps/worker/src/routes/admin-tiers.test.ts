import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminRouter } from './admin.js';
import type { Env } from '../types.js';
import { encrypt } from '../lib/crypto.js';

const API_KEY = 'test-api-key';
const API_SECRET = 'test-api-secret';
const SHOP_DOMAIN = 'demo.myshopify.com';
const SHOP_ID = 7;
const MASTER_KEY = '00'.repeat(32);

interface TierRow {
  id: number;
  shop_id: number;
  name: string;
  discount_type: 'percent' | 'amount' | 'none';
  discount_value: number;
  min_order_value: number | null;
  min_order_units: number | null;
  free_shipping_threshold: number | null;
  flat_shipping_amount: number | null;
  pickup_only: number;
  priority: number;
  deleted_at: number | null;
}

interface MappingRow {
  shop_id: number;
  shopify_company_id: string;
  tier_id: number;
  credit_limit: number | null;
  updated_at: number;
}

interface State {
  shop_exists: boolean;
  tiers: Map<number, TierRow>;
  next_tier_id: number;
  mappings: Map<string, MappingRow>;
  queue: Array<{ id: string; topic: string; shop_domain: string; body: string }>;
}

function makeEnv(): { env: Env; state: State } {
  const state: State = {
    shop_exists: true,
    tiers: new Map(),
    next_tier_id: 1,
    mappings: new Map(),
    queue: [],
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
            if (!state.shop_exists) return null;
            const enc = await encrypt('shpat_FAKE', SHOP_DOMAIN, MASTER_KEY);
            return { id: SHOP_ID, access_token_encrypted: enc } as unknown as T;
          }
          if (sql.includes('SELECT id FROM shops')) {
            return state.shop_exists ? ({ id: SHOP_ID } as unknown as T) : null;
          }
          if (sql.includes('FROM tiers') && sql.includes('AND id = ?')) {
            const row = state.tiers.get(bound[1] as number);
            return row && row.shop_id === bound[0] ? (row as unknown as T) : null;
          }
          if (sql.startsWith('INSERT INTO tiers')) {
            const id = state.next_tier_id++;
            const row: TierRow = {
              id,
              shop_id: bound[0] as number,
              name: bound[1] as string,
              discount_type: bound[2] as TierRow['discount_type'],
              discount_value: bound[3] as number,
              min_order_value: bound[4] as number | null,
              min_order_units: bound[5] as number | null,
              free_shipping_threshold: bound[6] as number | null,
              flat_shipping_amount: bound[7] as number | null,
              pickup_only: bound[8] as number,
              priority: bound[9] as number,
              deleted_at: null,
            };
            state.tiers.set(id, row);
            return { id } as unknown as T;
          }
          return null;
        },
        async run(): Promise<D1Result> {
          if (sql.startsWith('UPDATE tiers SET') && sql.includes('deleted_at IS NULL')) {
            if (sql.includes('SET\n         name')) {
              const id = bound[10] as number;
              const shop_id = bound[9] as number;
              const row = state.tiers.get(id);
              if (!row || row.shop_id !== shop_id || row.deleted_at !== null) {
                return { success: true, meta: { changes: 0 } } as unknown as D1Result;
              }
              row.name = bound[0] as string;
              row.discount_type = bound[1] as TierRow['discount_type'];
              row.discount_value = bound[2] as number;
              row.min_order_value = bound[3] as number | null;
              row.min_order_units = bound[4] as number | null;
              row.free_shipping_threshold = bound[5] as number | null;
              row.flat_shipping_amount = bound[6] as number | null;
              row.pickup_only = bound[7] as number;
              row.priority = bound[8] as number;
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            if (sql.includes('SET deleted_at')) {
              const id = bound[2] as number;
              const shop_id = bound[1] as number;
              const row = state.tiers.get(id);
              if (!row || row.shop_id !== shop_id || row.deleted_at !== null) {
                return { success: true, meta: { changes: 0 } } as unknown as D1Result;
              }
              row.deleted_at = bound[0] as number;
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
          }
          if (sql.startsWith('INSERT INTO company_tier_mappings')) {
            const key = `${bound[0]}:${bound[1]}`;
            state.mappings.set(key, {
              shop_id: bound[0] as number,
              shopify_company_id: bound[1] as string,
              tier_id: bound[2] as number,
              credit_limit: bound[3] as number | null,
              updated_at: bound[4] as number,
            });
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (sql.startsWith('DELETE FROM company_tier_mappings')) {
            const key = `${bound[0]}:${bound[1]}`;
            const had = state.mappings.delete(key);
            return {
              success: true,
              meta: { changes: had ? 1 : 0 },
            } as unknown as D1Result;
          }
          return { success: true, meta: { changes: 0 } } as unknown as D1Result;
        },
        async all<T>(): Promise<D1Result<T>> {
          if (sql.includes('FROM tiers')) {
            const results = Array.from(state.tiers.values()).filter(
              t => t.shop_id === (bound[0] as number) && t.deleted_at === null,
            );
            return { results, success: true, meta: {} } as unknown as D1Result<T>;
          }
          if (sql.includes('FROM company_tier_mappings')) {
            const results = Array.from(state.mappings.values()).filter(
              m => m.shop_id === (bound[0] as number),
            );
            return { results, success: true, meta: {} } as unknown as D1Result<T>;
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

  const queue = {
    send: async (msg: unknown): Promise<void> => {
      state.queue.push(msg as State['queue'][number]);
    },
    sendBatch: async (): Promise<void> => undefined,
  } as unknown as Queue;

  const env: Env = {
    DB: db,
    KV_SESSIONS: {} as KVNamespace,
    KV_IDEMPOTENCY: {} as KVNamespace,
    KV_HOT_CACHE: {} as KVNamespace,
    ASSETS_BUCKET: {} as R2Bucket,
    WEBHOOK_QUEUE: queue,
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
  const enc = (obj: unknown): string =>
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
  app.use('*', async (c, next) => {
    Object.assign(c.env, env);
    await next();
  });
  return app;
}

async function authed(
  app: Hono<{ Bindings: Env }>,
  path: string,
  init: RequestInit = {},
  env: Env,
): Promise<Response> {
  const token = await makeSessionToken(API_SECRET, validClaims());
  return app.request(
    path,
    {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    },
    env,
  );
}

const validTierPayload = {
  name: 'Gold',
  discount_type: 'percent',
  discount_value: 10,
  min_order_value: null,
  min_order_units: null,
  free_shipping_threshold: null,
  flat_shipping_amount: null,
  pickup_only: false,
  priority: 0,
};

describe('Admin tier CRUD', () => {
  let env: Env;
  let state: State;
  beforeEach(() => {
    ({ env, state } = makeEnv());
  });

  it('401 without Authorization', async () => {
    const app = buildApp(env);
    const res = await app.request('/admin/tiers', {}, env);
    expect(res.status).toBe(401);
  });

  it('lists tiers (empty initially)', async () => {
    const app = buildApp(env);
    const res = await authed(app, '/admin/tiers', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tiers: [] });
  });

  it('creates a tier, returns 201, and enqueues a tiers_config republish', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      '/admin/tiers',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validTierPayload),
      },
      env,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { tier: { id: number; name: string } };
    expect(json.tier.id).toBe(1);
    expect(json.tier.name).toBe('Gold');
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].topic).toBe('_internal/publish-tiers-config');
  });

  it('rejects invalid tier payload with 400 and a specific message', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      '/admin/tiers',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validTierPayload, discount_value: 150 }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/discount_value/);
  });

  it('updates a tier', async () => {
    const app = buildApp(env);
    await authed(
      app,
      '/admin/tiers',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validTierPayload),
      },
      env,
    );
    const res = await authed(
      app,
      '/admin/tiers/1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validTierPayload, name: 'Gold v2', discount_value: 15 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { tier: { name: string; discount_value: number } };
    expect(json.tier.name).toBe('Gold v2');
    expect(json.tier.discount_value).toBe(15);
  });

  it('soft-deletes a tier and enqueues a republish', async () => {
    const app = buildApp(env);
    await authed(
      app,
      '/admin/tiers',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validTierPayload),
      },
      env,
    );
    state.queue.length = 0;
    const res = await authed(app, '/admin/tiers/1', { method: 'DELETE' }, env);
    expect(res.status).toBe(200);
    expect(state.queue.some(m => m.topic === '_internal/publish-tiers-config')).toBe(true);
    expect(state.tiers.get(1)?.deleted_at).not.toBeNull();
  });

  it('404 on update of a non-existent tier', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      '/admin/tiers/999',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validTierPayload),
      },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe('Admin company-tier mapping', () => {
  let env: Env;
  let state: State;
  const COMPANY_GID = 'gid://shopify/Company/100';

  beforeEach(async () => {
    ({ env, state } = makeEnv());
    const app = buildApp(env);
    await authed(
      app,
      '/admin/tiers',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validTierPayload),
      },
      env,
    );
    state.queue.length = 0;
  });

  it('upserts a mapping and enqueues a Company-metafield mirror', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      `/admin/company-mappings/${encodeURIComponent(COMPANY_GID)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier_id: 1, credit_limit: 5000 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].topic).toBe('_internal/mirror-company-tier');
    expect(JSON.parse(state.queue[0].body)).toEqual({
      shopify_company_id: COMPANY_GID,
      tier_id: 1,
    });
  });

  it('rejects mapping to a non-existent tier with 404', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      `/admin/company-mappings/${encodeURIComponent(COMPANY_GID)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier_id: 999 }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('rejects malformed Company GID with 400', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      `/admin/company-mappings/${encodeURIComponent('not-a-gid')}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier_id: 1 }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('delete enqueues a tier_id=null mirror', async () => {
    const app = buildApp(env);
    await authed(
      app,
      `/admin/company-mappings/${encodeURIComponent(COMPANY_GID)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier_id: 1 }),
      },
      env,
    );
    state.queue.length = 0;
    const res = await authed(
      app,
      `/admin/company-mappings/${encodeURIComponent(COMPANY_GID)}`,
      { method: 'DELETE' },
      env,
    );
    expect(res.status).toBe(200);
    expect(state.queue).toHaveLength(1);
    expect(JSON.parse(state.queue[0].body).tier_id).toBeNull();
  });
});
