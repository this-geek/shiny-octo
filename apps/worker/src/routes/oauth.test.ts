import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { oauthRouter } from './oauth.js';
import type { Env } from '../types.js';

const API_KEY = 'test-api-key';
const API_SECRET = 'test-api-secret';
const APP_URL = 'https://app.example.com';

interface KvEntry {
  value: string;
  expirationTtl?: number;
}

function makeKv(): {
  kv: KVNamespace;
  store: Map<string, KvEntry>;
} {
  const store = new Map<string, KvEntry>();
  const kv: KVNamespace = {
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, { value, expirationTtl: opts?.expirationTtl });
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

function makeEnv(): { env: Env; sessionStore: Map<string, KvEntry> } {
  const { kv: KV_SESSIONS, store } = makeKv();
  const noop = {} as unknown;
  const env: Env = {
    DB: noop as D1Database,
    KV_SESSIONS,
    KV_IDEMPOTENCY: noop as KVNamespace,
    KV_HOT_CACHE: noop as KVNamespace,
    ASSETS_BUCKET: noop as R2Bucket,
    WEBHOOK_QUEUE: noop as Queue,
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    MASTER_KEY: '00'.repeat(32),
    RESEND_API_KEY: 'resend',
    APP_URL,
    SHOPIFY_API_VERSION: '2024-10',
    ADMIN_ORIGIN: 'https://admin.example.com',
  };
  return { env, sessionStore: store };
}

function makeApp(env: Env): (path: string, init?: RequestInit) => Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/auth', oauthRouter);
  return async (path: string, init?: RequestInit) =>
    app.request(path, init, env);
}

function parseSetCookie(header: string | null, name: string): Record<string, string> | null {
  if (!header) return null;
  const parts = header.split(/;\s*/);
  const first = parts[0];
  const eq = first.indexOf('=');
  if (eq === -1) return null;
  if (first.slice(0, eq) !== name) return null;
  const attrs: Record<string, string> = { value: first.slice(eq + 1) };
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const e = p.indexOf('=');
    if (e === -1) attrs[p.toLowerCase()] = '';
    else attrs[p.slice(0, e).toLowerCase()] = p.slice(e + 1);
  }
  return attrs;
}

describe('oauth /auth (initiate)', () => {
  let env: Env;
  let sessions: Map<string, KvEntry>;
  let request: (path: string, init?: RequestInit) => Promise<Response>;

  beforeEach(() => {
    const made = makeEnv();
    env = made.env;
    sessions = made.sessionStore;
    request = makeApp(env);
  });

  it('rejects missing shop', async () => {
    const res = await request('/auth');
    expect(res.status).toBe(400);
  });

  it('rejects malformed shop', async () => {
    const res = await request('/auth?shop=evil.com');
    expect(res.status).toBe(400);
  });

  it('rejects an overlong shop value', async () => {
    const tooLong = 'a'.repeat(200) + '.myshopify.com';
    const res = await request(`/auth?shop=${tooLong}`);
    expect(res.status).toBe(400);
  });

  it('normalizes mixed-case shop to lowercase in the authorize redirect', async () => {
    const res = await request('/auth?shop=Demo.MyShopify.com');
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location.startsWith('https://demo.myshopify.com/admin/oauth/authorize')).toBe(true);
  });

  it('sets a state cookie that matches the state query param and is properly attributed', async () => {
    const res = await request('/auth?shop=demo.myshopify.com');
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const stateParam = new URL(location).searchParams.get('state')!;
    expect(stateParam).toMatch(/^[0-9a-f]{32}$/);
    const cookie = parseSetCookie(res.headers.get('set-cookie'), 'oauth_state');
    expect(cookie).not.toBeNull();
    expect(cookie!.value).toBe(stateParam);
    expect(Object.keys(cookie!)).toEqual(
      expect.arrayContaining(['httponly', 'secure']),
    );
    expect(cookie!.samesite?.toLowerCase()).toBe('lax');
    expect(cookie!.path).toBe('/');
  });

  it('keys the KV nonce entry by the nonce itself, not by shop (so concurrent /auth does not overwrite)', async () => {
    const res1 = await request('/auth?shop=demo.myshopify.com');
    const res2 = await request('/auth?shop=demo.myshopify.com');
    expect(res1.status).toBe(302);
    expect(res2.status).toBe(302);
    const state1 = new URL(res1.headers.get('location')!).searchParams.get('state')!;
    const state2 = new URL(res2.headers.get('location')!).searchParams.get('state')!;
    expect(state1).not.toBe(state2);
    // Both nonces should be retained in KV — neither overwritten by the other.
    expect(sessions.has(`oauth:nonce:${state1}`)).toBe(true);
    expect(sessions.has(`oauth:nonce:${state2}`)).toBe(true);
  });
});

describe('oauth /auth/callback (defenses)', () => {
  let env: Env;
  let sessions: Map<string, KvEntry>;
  let request: (path: string, init?: RequestInit) => Promise<Response>;

  beforeEach(() => {
    const made = makeEnv();
    env = made.env;
    sessions = made.sessionStore;
    request = makeApp(env);
  });

  async function seedNonce(shop: string, nonce: string): Promise<void> {
    await env.KV_SESSIONS.put(`oauth:nonce:${nonce}`, shop, { expirationTtl: 600 });
  }

  // Build a callback URL with a VALID HMAC over its params so we exercise the
  // post-HMAC defenses (state cookie / KV / shop). The HMAC has to match what
  // verifyOAuthHmac computes, so we compute it the same way.
  async function signedCallback(params: Record<string, string>): Promise<string> {
    const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
    const message = entries.map(([k, v]) => `${k}=${v}`).join('&');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(API_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    const hmac = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const qs = new URLSearchParams({ ...params, hmac });
    return `/auth/callback?${qs.toString()}`;
  }

  it('rejects when the state cookie is missing (CSRF protection)', async () => {
    const nonce = 'a'.repeat(32);
    await seedNonce('demo.myshopify.com', nonce);
    const url = await signedCallback({
      shop: 'demo.myshopify.com',
      code: 'abc',
      state: nonce,
      timestamp: '1700000000',
    });
    const res = await request(url);
    expect(res.status).toBe(401);
  });

  it('rejects when the state cookie does not match the state query param', async () => {
    const nonce = 'a'.repeat(32);
    await seedNonce('demo.myshopify.com', nonce);
    const url = await signedCallback({
      shop: 'demo.myshopify.com',
      code: 'abc',
      state: nonce,
      timestamp: '1700000000',
    });
    const res = await request(url, {
      headers: { cookie: `oauth_state=${'b'.repeat(32)}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects when the KV nonce entry is missing (single-use enforcement)', async () => {
    const nonce = 'a'.repeat(32);
    // Intentionally do NOT seed KV.
    const url = await signedCallback({
      shop: 'demo.myshopify.com',
      code: 'abc',
      state: nonce,
      timestamp: '1700000000',
    });
    const res = await request(url, {
      headers: { cookie: `oauth_state=${nonce}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects when the callback shop does not match the shop the nonce was issued for', async () => {
    const nonce = 'a'.repeat(32);
    await seedNonce('demo.myshopify.com', nonce);
    const url = await signedCallback({
      shop: 'attacker.myshopify.com',
      code: 'abc',
      state: nonce,
      timestamp: '1700000000',
    });
    const res = await request(url, {
      headers: { cookie: `oauth_state=${nonce}` },
    });
    expect(res.status).toBe(401);
    // KV entry MUST remain so the legitimate browser can still complete the flow.
    expect(sessions.has(`oauth:nonce:${nonce}`)).toBe(true);
  });

  it('rejects an overlong callback shop value', async () => {
    const nonce = 'a'.repeat(32);
    const tooLong = 'a'.repeat(200) + '.myshopify.com';
    const url = await signedCallback({
      shop: tooLong,
      code: 'abc',
      state: nonce,
      timestamp: '1700000000',
    });
    const res = await request(url, {
      headers: { cookie: `oauth_state=${nonce}` },
    });
    expect(res.status).toBe(400);
  });
});
