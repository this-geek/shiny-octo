import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { appProxyMiddleware, verifyAppProxySignature } from './app-proxy-hmac.js';
import type { Env } from '../types.js';

const SECRET = 'app-proxy-secret';

async function signProxy(params: Record<string, string | string[]>, secret: string): Promise<string> {
  const sorted = Object.keys(params).sort();
  const message = sorted
    .map(k => {
      const v = params[k];
      const value = Array.isArray(v) ? v.join(',') : v;
      return `${k}=${value}`;
    })
    .join('');

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

describe('verifyAppProxySignature', () => {
  it('valid signature passes', async () => {
    const params = { shop: 'demo.myshopify.com', path_prefix: '/apps/b2b', timestamp: '1700000000' };
    const sig = await signProxy(params, SECRET);
    const url = new URLSearchParams({ ...params, signature: sig });
    expect(await verifyAppProxySignature(url, SECRET)).toBe(true);
  });

  it('tampered param fails', async () => {
    const params = { shop: 'demo.myshopify.com', timestamp: '1700000000' };
    const sig = await signProxy(params, SECRET);
    const url = new URLSearchParams({ shop: 'evil.myshopify.com', timestamp: '1700000000', signature: sig });
    expect(await verifyAppProxySignature(url, SECRET)).toBe(false);
  });

  it('missing signature returns false', async () => {
    const url = new URLSearchParams({ shop: 'demo.myshopify.com' });
    expect(await verifyAppProxySignature(url, SECRET)).toBe(false);
  });

  it('multi-value params joined with comma', async () => {
    const params = { ids: ['a', 'b', 'c'], shop: 'demo.myshopify.com' };
    const sig = await signProxy(params, SECRET);
    const url = new URLSearchParams();
    url.append('ids', 'a');
    url.append('ids', 'b');
    url.append('ids', 'c');
    url.append('shop', 'demo.myshopify.com');
    url.append('signature', sig);
    expect(await verifyAppProxySignature(url, SECRET)).toBe(true);
  });
});

describe('appProxyMiddleware', () => {
  function buildApp(): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', appProxyMiddleware);
    app.get('/test', c => c.json({ ok: true }));
    return app;
  }

  function envWithSecret(): Env {
    return {
      DB: {} as D1Database,
      KV_SESSIONS: {} as KVNamespace,
      KV_IDEMPOTENCY: {} as KVNamespace,
      KV_HOT_CACHE: {} as KVNamespace,
      ASSETS_BUCKET: {} as R2Bucket,
      WEBHOOK_QUEUE: {} as Queue,
      SHOPIFY_API_KEY: 'k',
      SHOPIFY_API_SECRET: SECRET,
      MASTER_KEY: '00'.repeat(32),
      RESEND_API_KEY: '',
      APP_URL: 'https://w.example.com',
      SHOPIFY_API_VERSION: '2026-04',
    };
  }

  it('401 when signature missing', async () => {
    const app = buildApp();
    const res = await app.request('/test?shop=demo.myshopify.com', {}, envWithSecret());
    expect(res.status).toBe(401);
  });

  it('200 when signature valid', async () => {
    const app = buildApp();
    const params = { shop: 'demo.myshopify.com', timestamp: '1700000000' };
    const sig = await signProxy(params, SECRET);
    const url = `/test?shop=${params.shop}&timestamp=${params.timestamp}&signature=${sig}`;
    const res = await app.request(url, {}, envWithSecret());
    expect(res.status).toBe(200);
  });

  it('401 when signature tampered', async () => {
    const app = buildApp();
    const params = { shop: 'demo.myshopify.com', timestamp: '1700000000' };
    const sig = await signProxy(params, SECRET);
    const bad = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
    const url = `/test?shop=${params.shop}&timestamp=${params.timestamp}&signature=${bad}`;
    const res = await app.request(url, {}, envWithSecret());
    expect(res.status).toBe(401);
  });
});
