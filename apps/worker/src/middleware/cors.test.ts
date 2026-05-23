import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { adminCors } from './cors.js';

const ADMIN_ORIGIN = 'https://b2b-companion-admin.pages.dev';

function envWith(origin: string | undefined): Env {
  return {
    DB: {} as D1Database,
    KV_SESSIONS: {} as KVNamespace,
    KV_IDEMPOTENCY: {} as KVNamespace,
    KV_HOT_CACHE: {} as KVNamespace,
    ASSETS_BUCKET: {} as R2Bucket,
    WEBHOOK_QUEUE: {} as Queue,
    SHOPIFY_API_KEY: 'k',
    SHOPIFY_API_SECRET: 's',
    MASTER_KEY: '00'.repeat(32),
    RESEND_API_KEY: '',
    APP_URL: 'https://worker.example.com',
    SHOPIFY_API_VERSION: '2026-04',
    ADMIN_ORIGIN: origin as string,
  };
}

function appWithCors(env: Env): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', adminCors);
  app.get('/admin/ping', c => c.json({ ok: true }));
  app.post('/admin/echo', async c => c.json({ body: await c.req.json() }));
  app.use('*', async (c, next) => {
    Object.assign(c.env, env);
    await next();
  });
  return app;
}

describe('adminCors: OPTIONS preflight', () => {
  it('returns 204 with CORS headers when Origin matches ADMIN_ORIGIN', async () => {
    const env = envWith(ADMIN_ORIGIN);
    const app = appWithCors(env);
    const res = await app.request(
      '/admin/tiers',
      {
        method: 'OPTIONS',
        headers: {
          Origin: ADMIN_ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      },
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ADMIN_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toMatch(/PUT/);
    expect(res.headers.get('Access-Control-Allow-Methods')).toMatch(/DELETE/);
    expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
      'authorization',
    );
    expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
      'content-type',
    );
    expect(res.headers.get('Vary')?.toLowerCase()).toContain('origin');
  });

  it('does NOT emit CORS headers when Origin is not allowlisted', async () => {
    const env = envWith(ADMIN_ORIGIN);
    const app = appWithCors(env);
    const res = await app.request(
      '/admin/tiers',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example.com',
          'Access-Control-Request-Method': 'POST',
        },
      },
      env,
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('preflight short-circuits BEFORE downstream middleware runs', async () => {
    const env = envWith(ADMIN_ORIGIN);
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', adminCors);
    let downstreamCalled = false;
    app.use('*', async (_c, next) => {
      downstreamCalled = true;
      await next();
    });
    app.get('/admin/anything', c => c.text('ok'));
    app.use('*', async (c, next) => {
      Object.assign(c.env, env);
      await next();
    });

    await app.request(
      '/admin/anything',
      {
        method: 'OPTIONS',
        headers: {
          Origin: ADMIN_ORIGIN,
          'Access-Control-Request-Method': 'GET',
        },
      },
      env,
    );
    expect(downstreamCalled).toBe(false);
  });
});

describe('adminCors: non-OPTIONS requests', () => {
  it('adds Access-Control-Allow-Origin to a real response when Origin matches', async () => {
    const env = envWith(ADMIN_ORIGIN);
    const app = appWithCors(env);
    const res = await app.request(
      '/admin/ping',
      { headers: { Origin: ADMIN_ORIGIN } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ADMIN_ORIGIN);
    expect(res.headers.get('Vary')?.toLowerCase()).toContain('origin');
  });

  it('does NOT add CORS headers when Origin is missing (same-origin / server-side call)', async () => {
    const env = envWith(ADMIN_ORIGIN);
    const app = appWithCors(env);
    const res = await app.request('/admin/ping', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('does NOT add CORS headers when Origin is foreign', async () => {
    const env = envWith(ADMIN_ORIGIN);
    const app = appWithCors(env);
    const res = await app.request(
      '/admin/ping',
      { headers: { Origin: 'https://evil.example.com' } },
      env,
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows multiple origins from comma-separated ADMIN_ORIGIN', async () => {
    const env = envWith(`${ADMIN_ORIGIN},https://staging.b2b-companion-admin.pages.dev`);
    const app = appWithCors(env);
    const res = await app.request(
      '/admin/ping',
      { headers: { Origin: 'https://staging.b2b-companion-admin.pages.dev' } },
      env,
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://staging.b2b-companion-admin.pages.dev',
    );
  });
});

describe('adminCors: misconfigured ADMIN_ORIGIN', () => {
  it('emits no CORS headers when ADMIN_ORIGIN is unset', async () => {
    const env = envWith(undefined);
    const app = appWithCors(env);
    const res = await app.request(
      '/admin/ping',
      { headers: { Origin: ADMIN_ORIGIN } },
      env,
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
