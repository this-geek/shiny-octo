import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import {
  ADMIN_LIMIT_PER_MIN,
  PUBLIC_LIMIT_PER_MIN,
  adminRateLimit,
  publicRateLimit,
} from './rate-limit.js';

function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<KVNamespaceListResult<unknown, string>> {
      return { keys: [], list_complete: true, cacheStatus: null };
    },
    async getWithMetadata(): Promise<KVNamespaceGetWithMetadataResult<string, unknown>> {
      return { value: null, metadata: null, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

function envWith(kv: KVNamespace): Env {
  return {
    DB: {} as D1Database,
    KV_SESSIONS: {} as KVNamespace,
    KV_IDEMPOTENCY: {} as KVNamespace,
    KV_HOT_CACHE: kv,
    ASSETS_BUCKET: {} as R2Bucket,
    WEBHOOK_QUEUE: {} as Queue,
    SHOPIFY_API_KEY: 'k',
    SHOPIFY_API_SECRET: 's',
    MASTER_KEY: '00'.repeat(32),
    RESEND_API_KEY: '',
    APP_URL: 'https://worker.example.com',
    SHOPIFY_API_VERSION: '2026-04',
    ADMIN_ORIGIN: 'https://admin.example.com',
  };
}

function adminApp(env: Env): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  // Stub session-token middleware: just set shopDomain from a header.
  app.use('*', async (c, next) => {
    const shop = c.req.header('X-Test-Shop');
    if (shop) c.set('shopDomain', shop);
    Object.assign(c.env, env);
    await next();
  });
  app.use('*', adminRateLimit);
  app.get('/admin/ping', c => c.json({ ok: true }));
  return app;
}

function publicApp(env: Env): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    Object.assign(c.env, env);
    await next();
  });
  app.use('*', publicRateLimit);
  app.get('/proxy/ping', c => c.json({ ok: true }));
  return app;
}

describe('adminRateLimit', () => {
  it(`allows up to ${ADMIN_LIMIT_PER_MIN}/min per shop`, async () => {
    const env = envWith(fakeKv());
    const app = adminApp(env);
    for (let i = 0; i < ADMIN_LIMIT_PER_MIN; i++) {
      const res = await app.request(
        '/admin/ping',
        { headers: { 'X-Test-Shop': 'shop-a.myshopify.com' } },
        env,
      );
      expect(res.status).toBe(200);
    }
    const denied = await app.request(
      '/admin/ping',
      { headers: { 'X-Test-Shop': 'shop-a.myshopify.com' } },
      env,
    );
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(await denied.json()).toEqual({ error: 'rate_limited' });
  });

  it('limits buckets each shop independently', async () => {
    const env = envWith(fakeKv());
    const app = adminApp(env);
    for (let i = 0; i < ADMIN_LIMIT_PER_MIN; i++) {
      await app.request(
        '/admin/ping',
        { headers: { 'X-Test-Shop': 'shop-a.myshopify.com' } },
        env,
      );
    }
    // shop-a denied; shop-b still fresh
    const aDenied = await app.request(
      '/admin/ping',
      { headers: { 'X-Test-Shop': 'shop-a.myshopify.com' } },
      env,
    );
    const bOk = await app.request(
      '/admin/ping',
      { headers: { 'X-Test-Shop': 'shop-b.myshopify.com' } },
      env,
    );
    expect(aDenied.status).toBe(429);
    expect(bOk.status).toBe(200);
  });

  it('passes through when shopDomain is not set (defers to upstream auth)', async () => {
    const env = envWith(fakeKv());
    const app = adminApp(env);
    // No X-Test-Shop header → no shopDomain → rate-limit no-ops, request 200s.
    const res = await app.request('/admin/ping', {}, env);
    expect(res.status).toBe(200);
  });
});

describe('publicRateLimit', () => {
  it(`allows up to ${PUBLIC_LIMIT_PER_MIN}/min per IP`, async () => {
    const env = envWith(fakeKv());
    const app = publicApp(env);
    for (let i = 0; i < PUBLIC_LIMIT_PER_MIN; i++) {
      const res = await app.request(
        '/proxy/ping',
        { headers: { 'CF-Connecting-IP': '1.2.3.4' } },
        env,
      );
      expect(res.status).toBe(200);
    }
    const denied = await app.request(
      '/proxy/ping',
      { headers: { 'CF-Connecting-IP': '1.2.3.4' } },
      env,
    );
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toMatch(/^\d+$/);
  });

  it('limits buckets each IP independently', async () => {
    const env = envWith(fakeKv());
    const app = publicApp(env);
    for (let i = 0; i < PUBLIC_LIMIT_PER_MIN; i++) {
      await app.request(
        '/proxy/ping',
        { headers: { 'CF-Connecting-IP': '1.2.3.4' } },
        env,
      );
    }
    const aDenied = await app.request(
      '/proxy/ping',
      { headers: { 'CF-Connecting-IP': '1.2.3.4' } },
      env,
    );
    const bOk = await app.request(
      '/proxy/ping',
      { headers: { 'CF-Connecting-IP': '5.6.7.8' } },
      env,
    );
    expect(aDenied.status).toBe(429);
    expect(bOk.status).toBe(200);
  });

  it('falls back to a single "unknown" bucket when CF-Connecting-IP is missing', async () => {
    const env = envWith(fakeKv());
    const app = publicApp(env);
    for (let i = 0; i < PUBLIC_LIMIT_PER_MIN; i++) {
      const res = await app.request('/proxy/ping', {}, env);
      expect(res.status).toBe(200);
    }
    const denied = await app.request('/proxy/ping', {}, env);
    expect(denied.status).toBe(429);
  });

  it('fails open when the KV namespace throws (defensive layer must not break the request)', async () => {
    const brokenKv = {
      get: async () => {
        throw new Error('KV unavailable');
      },
      put: async () => {
        throw new Error('KV unavailable');
      },
    } as unknown as KVNamespace;
    const env = envWith(brokenKv);
    const app = publicApp(env);
    const res = await app.request(
      '/proxy/ping',
      { headers: { 'CF-Connecting-IP': '1.1.1.1' } },
      env,
    );
    expect(res.status).toBe(200);
  });

  it('429 response carries no-store cache-control', async () => {
    const env = envWith(fakeKv());
    const app = publicApp(env);
    for (let i = 0; i < PUBLIC_LIMIT_PER_MIN; i++) {
      await app.request(
        '/proxy/ping',
        { headers: { 'CF-Connecting-IP': '9.9.9.9' } },
        env,
      );
    }
    const denied = await app.request(
      '/proxy/ping',
      { headers: { 'CF-Connecting-IP': '9.9.9.9' } },
      env,
    );
    expect(denied.headers.get('Cache-Control')).toMatch(/no-store/);
  });
});
