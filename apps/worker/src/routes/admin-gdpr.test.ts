import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminRouter } from './admin.js';
import type { Env } from '../types.js';
import { encrypt } from '../lib/crypto.js';
import {
  CUSTOMER_REDACT_GRACE_S,
  insertGdprRequest,
  type GdprRequestRow,
} from '../lib/gdpr-store.js';

const API_KEY = 'test-api-key';
const API_SECRET = 'test-api-secret';
const SHOP_DOMAIN = 'demo.myshopify.com';
const OTHER_SHOP_DOMAIN = 'other.myshopify.com';
const MASTER_KEY = '00'.repeat(32);

interface Shop {
  id: number;
  shopify_domain: string;
}

function makeEnv(): { env: Env; rows: GdprRequestRow[]; shops: Shop[] } {
  const rows: GdprRequestRow[] = [];
  const shops: Shop[] = [
    { id: 7, shopify_domain: SHOP_DOMAIN },
    { id: 99, shopify_domain: OTHER_SHOP_DOMAIN },
  ];

  const db: D1Database = {
    prepare(rawSql: string) {
      let bound: unknown[] = [];
      const sql = rawSql.replace(/\s+/g, ' ').trim();
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          // Token-exchange middleware look-up: returns an encrypted token blob.
          if (sql.includes('access_token_encrypted') && sql.includes('uninstalled_at IS NULL')) {
            const enc = await encrypt('shpat_FAKE', SHOP_DOMAIN, MASTER_KEY);
            return { id: 7, access_token_encrypted: enc } as unknown as T;
          }
          if (sql.startsWith('SELECT id FROM shops WHERE shopify_domain = ?')) {
            const [d] = bound as [string];
            const s = shops.find(r => r.shopify_domain === d);
            return s ? ({ id: s.id } as unknown as T) : null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (
            sql.startsWith('SELECT * FROM gdpr_requests') &&
            sql.includes("status = 'pending'") &&
            sql.includes('shop_id = ?')
          ) {
            const [shopId] = bound as [number];
            const out = rows
              .filter(r => r.shop_id === shopId && r.status === 'pending')
              .sort((a, b) => a.due_at - b.due_at);
            return { results: out as unknown as T[] };
          }
          return { results: [] };
        },
        async run() {
          const m = (changes: number) =>
            ({ success: true, meta: { changes } } as unknown as D1Result);
          if (sql.startsWith('INSERT OR IGNORE INTO gdpr_requests')) {
            const [
              id,
              shop_id,
              shop_domain,
              kind,
              shopify_customer_id,
              payload_json,
              received_at,
              due_at,
            ] = bound as [
              string,
              number | null,
              string,
              GdprRequestRow['kind'],
              string | null,
              string,
              number,
              number,
            ];
            if (rows.some(r => r.id === id)) return m(0);
            rows.push({
              id,
              shop_id,
              shop_domain,
              kind,
              shopify_customer_id,
              payload_json,
              received_at,
              due_at,
              status: 'pending',
              completed_at: null,
              last_error: null,
            });
            return m(1);
          }
          if (sql.includes("UPDATE gdpr_requests SET status = 'cancelled'")) {
            const [id, shopId, now] = bound as [string, number, number];
            const row = rows.find(r => r.id === id);
            if (!row || row.shop_id !== shopId || row.status !== 'pending' || row.due_at <= now) {
              return m(0);
            }
            row.status = 'cancelled';
            return m(1);
          }
          if (sql.includes('UPDATE gdpr_requests SET due_at = ?')) {
            const [newDue, id, shopId] = bound as [number, string, number];
            const row = rows.find(r => r.id === id);
            if (!row || row.shop_id !== shopId || row.status !== 'pending') return m(0);
            row.due_at = newDue;
            return m(1);
          }
          return m(0);
        },
      };
      return stmt as unknown as D1PreparedStatement;
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
  return { env, rows, shops };
}

async function makeSessionToken(
  secret: string,
  claims: Record<string, unknown>,
): Promise<string> {
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
  app.use('*', async (c, next) => {
    Object.assign(c.env, env);
    await next();
  });
  return app;
}

async function authHeader(): Promise<{ Authorization: string }> {
  const token = await makeSessionToken(API_SECRET, validClaims());
  return { Authorization: `Bearer ${token}` };
}

const NOW = Math.floor(Date.now() / 1000);

async function seedRequest(
  env: Env,
  overrides: Partial<Parameters<typeof insertGdprRequest>[1]> = {},
): Promise<string> {
  const input = {
    id: overrides.id ?? `wh-${Math.random().toString(36).slice(2, 8)}`,
    shop_id: 7,
    shop_domain: SHOP_DOMAIN,
    kind: 'customer_redact' as const,
    shopify_customer_id: '101',
    payload_json: '{}',
    received_at: NOW,
    due_at: NOW + CUSTOMER_REDACT_GRACE_S,
    ...overrides,
  };
  await insertGdprRequest(env.DB, input);
  return input.id;
}

describe('admin-gdpr routes', () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv().env;
  });

  it('GET /admin/gdpr/pending requires auth', async () => {
    const app = buildApp(env);
    const res = await app.request('/admin/gdpr/pending', {}, env);
    expect(res.status).toBe(401);
  });

  it('GET /admin/gdpr/pending lists this shop\'s pending requests in due-asc order', async () => {
    await seedRequest(env, { id: 'a', due_at: NOW + 1000 });
    await seedRequest(env, { id: 'b', due_at: NOW + 10 });
    await seedRequest(env, { id: 'c', shop_id: 99, due_at: NOW + 5 });
    const app = buildApp(env);
    const res = await app.request(
      '/admin/gdpr/pending',
      { headers: await authHeader() },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { requests: Array<{ id: string }> };
    expect(json.requests.map(r => r.id)).toEqual(['b', 'a']);
  });

  it('POST /admin/gdpr/:id/cancel marks the row cancelled during stand-down', async () => {
    const id = await seedRequest(env);
    const app = buildApp(env);
    const res = await app.request(
      `/admin/gdpr/${id}/cancel`,
      { method: 'POST', headers: await authHeader() },
      env,
    );
    expect(res.status).toBe(200);
    const list = await app.request(
      '/admin/gdpr/pending',
      { headers: await authHeader() },
      env,
    );
    const json = (await list.json()) as { requests: unknown[] };
    expect(json.requests).toEqual([]);
  });

  it('POST /admin/gdpr/:id/cancel is refused after the stand-down', async () => {
    const id = await seedRequest(env, { due_at: NOW - 1 });
    const app = buildApp(env);
    const res = await app.request(
      `/admin/gdpr/${id}/cancel`,
      { method: 'POST', headers: await authHeader() },
      env,
    );
    expect(res.status).toBe(409);
  });

  it('POST /admin/gdpr/:id/cancel is refused cross-shop', async () => {
    const id = await seedRequest(env, { shop_id: 99 });
    const app = buildApp(env);
    const res = await app.request(
      `/admin/gdpr/${id}/cancel`,
      { method: 'POST', headers: await authHeader() },
      env,
    );
    expect(res.status).toBe(409);
  });

  it('POST /admin/gdpr/:id/process pulls due_at to now', async () => {
    const id = await seedRequest(env, { due_at: NOW + 100_000 });
    const app = buildApp(env);
    const res = await app.request(
      `/admin/gdpr/${id}/process`,
      { method: 'POST', headers: await authHeader() },
      env,
    );
    expect(res.status).toBe(200);
    const list = await app.request(
      '/admin/gdpr/pending',
      { headers: await authHeader() },
      env,
    );
    const json = (await list.json()) as {
      requests: Array<{ id: string; due_at: number }>;
    };
    const row = json.requests.find(r => r.id === id);
    expect(row).toBeDefined();
    expect(row!.due_at).toBeLessThanOrEqual(NOW + 5);
  });

  it('POST /admin/gdpr/:id/process refuses cross-shop expedite', async () => {
    const id = await seedRequest(env, { shop_id: 99 });
    const app = buildApp(env);
    const res = await app.request(
      `/admin/gdpr/${id}/process`,
      { method: 'POST', headers: await authHeader() },
      env,
    );
    expect(res.status).toBe(409);
  });
});
