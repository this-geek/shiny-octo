import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { opsRouter } from './ops.js';
import { Hono } from 'hono';
import type { Env } from '../types.js';

const TEAM = 'acme';
const AUD = 'a'.repeat(64);
const NOW = 1_700_000_000;

interface KeyPair {
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
  kid: string;
}

let keyPair: KeyPair;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  keyPair = { publicJwk, privateKey: pair.privateKey, kid: 'kid-1' };
});

function b64url(input: Uint8Array | string): string {
  const buf = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: keyPair.kid }));
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function freshAccessToken(): Promise<string> {
  return signJwt({
    aud: AUD,
    email: 'op@example.com',
    sub: 'cf-user-1',
    iss: `https://${TEAM}.cloudflareaccess.com`,
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

interface ShopRow {
  id: number;
  shopify_domain: string;
  shopify_shop_id: number;
  is_plus: number;
  plan_id: string;
  installed_at: number;
  uninstalled_at: number | null;
  settings_json: string;
}

interface OpsLogRow {
  id: number;
  shop_id: number | null;
  operator_email: string;
  action: string;
  details_json: string | null;
  occurred_at: number;
}

interface State {
  shops: ShopRow[];
  ops_log: OpsLogRow[];
  nextOpsId: number;
}

function fakeDb(state: State): D1Database {
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]): D1PreparedStatement {
          bound = args;
          return stmt as unknown as D1PreparedStatement;
        },
        async first<T>() {
          if (sql.includes('FROM shops') && sql.includes('shopify_domain = ?')) {
            const domain = bound[0] as string;
            const shop = state.shops.find(s => s.shopify_domain === domain);
            if (!shop) return null;
            if (sql.includes('settings_json')) {
              return { settings_json: shop.settings_json } as unknown as T;
            }
            return shop as unknown as T;
          }
          return null;
        },
        async all<T>(): Promise<D1Result<T>> {
          if (sql.includes('FROM shops')) {
            return {
              results: state.shops as unknown as T[],
              success: true,
              meta: {},
            } as unknown as D1Result<T>;
          }
          if (sql.includes('FROM ops_log')) {
            return {
              results: state.ops_log as unknown as T[],
              success: true,
              meta: {},
            } as unknown as D1Result<T>;
          }
          return { results: [], success: true, meta: {} } as unknown as D1Result<T>;
        },
        async run() {
          if (sql.includes('UPDATE shops SET settings_json')) {
            const [json, domain] = bound as [string, string];
            const shop = state.shops.find(s => s.shopify_domain === domain);
            if (shop) shop.settings_json = json;
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (sql.includes('INSERT INTO ops_log')) {
            const [shopId, email, action, detailsJson, occurredAt] = bound as [
              number | null,
              string,
              string,
              string | null,
              number,
            ];
            state.ops_log.push({
              id: state.nextOpsId++,
              shop_id: shopId,
              operator_email: email,
              action,
              details_json: detailsJson,
              occurred_at: occurredAt,
            });
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          return { success: true, meta: { changes: 0 } } as unknown as D1Result;
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
    async delete(k: string) {
      store.delete(k);
    },
  } as unknown as KVNamespace;
}

function makeEnv(state: State): Env {
  return {
    DB: fakeDb(state),
    KV_SESSIONS: fakeKv(),
    KV_IDEMPOTENCY: fakeKv(),
    KV_HOT_CACHE: fakeKv(),
    ASSETS_BUCKET: {} as R2Bucket,
    WEBHOOK_QUEUE: {} as Queue,
    SHOPIFY_API_KEY: 'k',
    SHOPIFY_API_SECRET: 's',
    MASTER_KEY: '00'.repeat(32),
    RESEND_API_KEY: '',
    APP_URL: 'https://worker.example',
    SHOPIFY_API_VERSION: '2026-04',
    ADMIN_ORIGIN: 'https://admin.example',
    OPS_ACCESS_TEAM: TEAM,
    OPS_ACCESS_AUD: AUD,
  };
}

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/_ops', opsRouter);
  return app;
}

function mockJwks(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.includes('/cdn-cgi/access/certs')) {
      return new Response(
        JSON.stringify({
          keys: [
            {
              kty: keyPair.publicJwk.kty,
              kid: keyPair.kid,
              n: keyPair.publicJwk.n,
              e: keyPair.publicJwk.e,
              alg: 'RS256',
              use: 'sig',
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function freshState(): State {
  return {
    shops: [
      {
        id: 1,
        shopify_domain: 'a.myshopify.com',
        shopify_shop_id: 1001,
        is_plus: 0,
        plan_id: 'advanced',
        installed_at: NOW - 86400,
        uninstalled_at: null,
        settings_json: '{}',
      },
      {
        id: 2,
        shopify_domain: 'b.myshopify.com',
        shopify_shop_id: 1002,
        is_plus: 1,
        plan_id: 'plus',
        installed_at: NOW - 3600,
        uninstalled_at: null,
        settings_json: JSON.stringify({ featureFlags: { quick_order: true } }),
      },
    ],
    ops_log: [],
    nextOpsId: 1,
  };
}

beforeEach(() => {
  mockJwks();
});

describe('/_ops auth', () => {
  it('refuses requests without Cf-Access-Jwt-Assertion', async () => {
    const state = freshState();
    const env = makeEnv(state);
    const app = makeApp();
    const res = await app.request('/_ops/whoami', {}, env);
    expect(res.status).toBe(401);
  });

  it('refuses when OPS_ACCESS_TEAM is not configured', async () => {
    const state = freshState();
    const env = makeEnv(state);
    env.OPS_ACCESS_TEAM = undefined;
    const app = makeApp();
    const token = await freshAccessToken();
    const res = await app.request('/_ops/whoami', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    }, env);
    expect(res.status).toBe(503);
  });

  it('exposes the verified operator email on /whoami', async () => {
    const state = freshState();
    const env = makeEnv(state);
    const app = makeApp();
    const token = await freshAccessToken();
    const res = await app.request('/_ops/whoami', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string };
    expect(body.email).toBe('op@example.com');
  });
});

describe('/_ops/shops', () => {
  it('lists every shop with is_plus normalised to boolean', async () => {
    const state = freshState();
    const env = makeEnv(state);
    const app = makeApp();
    const token = await freshAccessToken();
    const res = await app.request('/_ops/shops', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      shops: Array<{ shopify_domain: string; is_plus: boolean }>;
    };
    expect(body.shops).toHaveLength(2);
    expect(body.shops.find(s => s.shopify_domain === 'b.myshopify.com')?.is_plus).toBe(
      true,
    );
  });
});

describe('/_ops/shops/:domain/feature-flags', () => {
  it('reads existing flags', async () => {
    const state = freshState();
    const env = makeEnv(state);
    const app = makeApp();
    const token = await freshAccessToken();
    const res = await app.request('/_ops/shops/b.myshopify.com/feature-flags', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ flags: { quick_order: true } });
  });

  it('writes flags and logs the change to ops_log', async () => {
    const state = freshState();
    const env = makeEnv(state);
    const app = makeApp();
    const token = await freshAccessToken();
    const res = await app.request('/_ops/shops/a.myshopify.com/feature-flags', {
      method: 'PUT',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ flags: { quotes: true, saved_lists: false } }),
    }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: Record<string, boolean> };
    expect(body.flags).toEqual({ quotes: true, saved_lists: false });

    const shop = state.shops.find(s => s.shopify_domain === 'a.myshopify.com')!;
    expect(JSON.parse(shop.settings_json)).toEqual({
      featureFlags: { quotes: true, saved_lists: false },
    });
    expect(state.ops_log).toHaveLength(1);
    expect(state.ops_log[0].operator_email).toBe('op@example.com');
    expect(state.ops_log[0].action).toBe('feature_flags.update');
    expect(state.ops_log[0].shop_id).toBe(1);
  });

  it('rejects invalid flag names', async () => {
    const state = freshState();
    const env = makeEnv(state);
    const app = makeApp();
    const token = await freshAccessToken();
    const res = await app.request('/_ops/shops/a.myshopify.com/feature-flags', {
      method: 'PUT',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ flags: { 'Bad-Name': true } }),
    }, env);
    expect(res.status).toBe(400);
    expect(state.ops_log).toHaveLength(0);
  });

  it('rejects non-boolean flag values', async () => {
    const state = freshState();
    const env = makeEnv(state);
    const app = makeApp();
    const token = await freshAccessToken();
    const res = await app.request('/_ops/shops/a.myshopify.com/feature-flags', {
      method: 'PUT',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ flags: { quick_order: 'yes' } }),
    }, env);
    expect(res.status).toBe(400);
    expect(state.ops_log).toHaveLength(0);
  });

  it('returns 404 for unknown shop', async () => {
    const state = freshState();
    const env = makeEnv(state);
    const app = makeApp();
    const token = await freshAccessToken();
    const res = await app.request('/_ops/shops/missing.myshopify.com/feature-flags', {
      method: 'PUT',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ flags: { quick_order: true } }),
    }, env);
    expect(res.status).toBe(404);
    expect(state.ops_log).toHaveLength(0);
  });
});
