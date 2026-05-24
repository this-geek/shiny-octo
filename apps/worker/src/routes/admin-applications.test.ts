import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { adminRouter } from './admin.js';
import type { Env } from '../types.js';
import { encrypt } from '../lib/crypto.js';

const API_KEY = 'test-api-key';
const API_SECRET = 'test-api-secret';
const SHOP_DOMAIN = 'demo.myshopify.com';
const SHOP_ID = 7;
const MASTER_KEY = '00'.repeat(32);

interface ApplicationRow {
  id: number;
  shop_id: number;
  email: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'needs_info';
  form_data_encrypted: string;
  submitted_at: number | null;
  decided_at: number | null;
  decided_by: string | null;
  decision_notes: string | null;
  created_company_id: string | null;
  created_location_id: string | null;
  shopify_customer_id: string | null;
  created_at: number | null;
  last_autosaved_at: number | null;
}

interface State {
  apps: Map<number, ApplicationRow>;
  next_app_id: number;
  queue: Array<{ id: string; topic: string; shop_domain: string; body: string }>;
  encryptedToken: string;
}

async function makeEnv(): Promise<{ env: Env; state: State }> {
  const encryptedToken = await encrypt('shpat_FAKE', SHOP_DOMAIN, MASTER_KEY);

  const state: State = {
    apps: new Map(),
    next_app_id: 1,
    queue: [],
    encryptedToken,
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
          if (sql.includes('SELECT id FROM shops WHERE shopify_domain = ?')) {
            return { id: SHOP_ID } as unknown as T;
          }
          if (
            sql.includes('SELECT id, access_token_encrypted FROM shops') &&
            sql.includes('uninstalled_at IS NULL')
          ) {
            return {
              id: SHOP_ID,
              access_token_encrypted: state.encryptedToken,
            } as unknown as T;
          }
          if (
            sql.includes('FROM applications') &&
            sql.includes('AND id = ?') &&
            sql.includes('form_data_encrypted')
          ) {
            const row = state.apps.get(bound[1] as number);
            return row && row.shop_id === bound[0] ? (row as unknown as T) : null;
          }
          if (sql.includes('FROM applications') && sql.includes('AND id = ?')) {
            const row = state.apps.get(bound[1] as number);
            if (!row || row.shop_id !== (bound[0] as number)) return null;
            const { form_data_encrypted: _omit, ...rest } = row;
            return rest as unknown as T;
          }
          return null;
        },
        async run(): Promise<D1Result> {
          if (sql.startsWith('UPDATE applications') && sql.includes('SET status')) {
            const status = bound[0] as ApplicationRow['status'];
            const id = bound[8] as number;
            const shopId = bound[7] as number;
            const row = state.apps.get(id);
            if (!row || row.shop_id !== shopId) {
              return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            row.status = status;
            row.decided_at = bound[1] as number;
            row.decided_by = bound[2] as string;
            row.decision_notes = bound[3] as string | null;
            row.created_company_id = (bound[4] as string | null) ?? row.created_company_id;
            row.created_location_id = (bound[5] as string | null) ?? row.created_location_id;
            row.shopify_customer_id = (bound[6] as string | null) ?? row.shopify_customer_id;
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (sql.startsWith('UPDATE applications') && sql.includes('SET decided_at')) {
            // Idempotent re-apply refresh path
            const id = bound[4] as number;
            const shopId = bound[3] as number;
            const row = state.apps.get(id);
            if (!row || row.shop_id !== shopId) {
              return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            row.decided_at = bound[0] as number;
            row.decided_by = bound[1] as string;
            row.decision_notes = bound[2] as string | null;
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          return { success: true, meta: { changes: 0 } } as unknown as D1Result;
        },
        async all<T>(): Promise<D1Result<T>> {
          if (sql.includes('FROM applications')) {
            const shopId = bound[0] as number;
            const status = bound[1] as string | undefined;
            const rows = Array.from(state.apps.values())
              .filter(r => r.shop_id === shopId)
              .filter(r => (status ? r.status === status : true))
              .map(({ form_data_encrypted: _omit, ...rest }) => rest);
            return { results: rows, success: true, meta: {} } as unknown as D1Result<T>;
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
    EMAIL_FROM: 'b2b@example.com',
  };

  return { env, state };
}

async function makeSessionToken(secret: string, claims: Record<string, unknown>): Promise<string> {
  const enc = (obj: unknown): string =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  const headerB64 = enc({ alg: 'HS256', typ: 'JWT' });
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
    sub: 'staff-1',
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
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    },
    env,
  );
}

async function seedSubmitted(state: State): Promise<number> {
  const id = state.next_app_id++;
  const blob = await encrypt(
    JSON.stringify({ fields: {}, email: 'a@b.com', companyName: 'Acme', documents: [] }),
    SHOP_DOMAIN,
    MASTER_KEY,
  );
  state.apps.set(id, {
    id,
    shop_id: SHOP_ID,
    email: 'a@b.com',
    status: 'submitted',
    form_data_encrypted: blob,
    submitted_at: 1,
    decided_at: null,
    decided_by: null,
    decision_notes: null,
    created_company_id: null,
    created_location_id: null,
    shopify_customer_id: null,
    created_at: 1,
    last_autosaved_at: 1,
  });
  return id;
}

describe('admin applications: approve', () => {
  let env: Env;
  let state: State;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    ({ env, state } = await makeEnv());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockCompanyCreate(): ReturnType<typeof vi.fn> {
    return vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              companyCreate: {
                company: {
                  id: 'gid://shopify/Company/100',
                  mainContact: {
                    id: 'gid://shopify/CompanyContact/200',
                    customer: { id: 'gid://shopify/Customer/300' },
                  },
                  locations: { nodes: [{ id: 'gid://shopify/CompanyLocation/400' }] },
                },
                userErrors: [],
              },
            },
          }),
          { status: 200 },
        ),
      );
  }

  it('first approve creates a Company, enqueues an email, returns 200', async () => {
    const fetchMock = mockCompanyCreate();
    globalThis.fetch = fetchMock;

    const id = await seedSubmitted(state);
    const app = buildApp(env);
    const res = await authed(
      app,
      `/admin/applications/${id}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'lgtm' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      created_company_id: string;
      idempotent: boolean;
    };
    expect(json.created_company_id).toBe('gid://shopify/Company/100');
    expect(json.idempotent).toBe(false);
    expect(state.apps.get(id)?.status).toBe('approved');
    expect(state.queue.some(m => m.topic === '_internal/send-application-email')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('double-click approve does not create a second Company', async () => {
    const fetchMock = mockCompanyCreate();
    globalThis.fetch = fetchMock;

    const id = await seedSubmitted(state);
    const app = buildApp(env);
    const first = await authed(
      app,
      `/admin/applications/${id}/approve`,
      { method: 'POST' },
      env,
    );
    expect(first.status).toBe(200);

    state.queue.length = 0; // forget the first enqueue so the assertion below is clean

    const second = await authed(
      app,
      `/admin/applications/${id}/approve`,
      { method: 'POST' },
      env,
    );
    expect(second.status).toBe(200);
    const json = (await second.json()) as { idempotent: boolean; created_company_id: string };
    expect(json.idempotent).toBe(true);
    expect(json.created_company_id).toBe('gid://shopify/Company/100');

    // The second click never re-hits Shopify.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // And does not re-enqueue an approved email.
    expect(state.queue.length).toBe(0);
  });

  it('on companyCreate failure, the application stays in submitted and no row mutates', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            companyCreate: {
              company: null,
              userErrors: [{ message: 'name is taken', code: 'TAKEN' }],
            },
          },
        }),
        { status: 200 },
      ),
    );

    const id = await seedSubmitted(state);
    const app = buildApp(env);
    const res = await authed(
      app,
      `/admin/applications/${id}/approve`,
      { method: 'POST' },
      env,
    );
    expect(res.status).toBe(502);
    expect(state.apps.get(id)?.status).toBe('submitted');
    expect(state.apps.get(id)?.created_company_id).toBeNull();
    expect(state.queue.length).toBe(0);
  });

  it('cannot approve a rejected application', async () => {
    const id = await seedSubmitted(state);
    const row = state.apps.get(id)!;
    row.status = 'rejected';

    const app = buildApp(env);
    const res = await authed(
      app,
      `/admin/applications/${id}/approve`,
      { method: 'POST' },
      env,
    );
    expect(res.status).toBe(409);
  });
});

describe('admin applications: reject / request-info', () => {
  let env: Env;
  let state: State;
  beforeEach(async () => {
    ({ env, state } = await makeEnv());
  });

  it('reject records decision and enqueues an email', async () => {
    const id = await seedSubmitted(state);
    const app = buildApp(env);
    const res = await authed(
      app,
      `/admin/applications/${id}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'not a fit' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(state.apps.get(id)?.status).toBe('rejected');
    expect(state.apps.get(id)?.created_company_id).toBeNull();
    expect(state.queue.some(m => m.topic === '_internal/send-application-email')).toBe(true);
  });

  it('reject is idempotent — second call does not re-enqueue', async () => {
    const id = await seedSubmitted(state);
    const app = buildApp(env);
    await authed(
      app,
      `/admin/applications/${id}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'not a fit' }),
      },
      env,
    );
    state.queue.length = 0;
    const second = await authed(
      app,
      `/admin/applications/${id}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'not a fit' }),
      },
      env,
    );
    expect(second.status).toBe(200);
    const json = (await second.json()) as { idempotent: boolean };
    expect(json.idempotent).toBe(true);
    expect(state.queue.length).toBe(0);
  });

  it('request-info transitions to needs_info', async () => {
    const id = await seedSubmitted(state);
    const app = buildApp(env);
    const res = await authed(
      app,
      `/admin/applications/${id}/request-info`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'please send your reseller cert' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(state.apps.get(id)?.status).toBe('needs_info');
  });
});

describe('admin applications: list + detail', () => {
  let env: Env;
  let state: State;
  beforeEach(async () => {
    ({ env, state } = await makeEnv());
  });

  it('list filters by status', async () => {
    await seedSubmitted(state);
    await seedSubmitted(state);
    state.apps.get(2)!.status = 'approved';

    const app = buildApp(env);
    const res = await authed(app, '/admin/applications?status=submitted', {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { applications: Array<{ status: string }> };
    expect(json.applications).toHaveLength(1);
    expect(json.applications[0].status).toBe('submitted');
  });

  it('list rejects invalid status with 400', async () => {
    const app = buildApp(env);
    const res = await authed(app, '/admin/applications?status=bogus', {}, env);
    expect(res.status).toBe(400);
  });

  it('detail returns the decrypted form', async () => {
    const id = await seedSubmitted(state);
    const app = buildApp(env);
    const res = await authed(app, `/admin/applications/${id}`, {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      application: { form: { email: string; companyName: string } };
    };
    expect(json.application.form.email).toBe('a@b.com');
    expect(json.application.form.companyName).toBe('Acme');
  });
});
