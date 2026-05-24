import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { adminRouter } from './admin.js';
import type { Env } from '../types.js';

const API_KEY = 'test-api-key';
const API_SECRET = 'test-api-secret';
const SHOP_DOMAIN = 'demo.myshopify.com';
const SHOP_ID = 7;

interface FolderRow {
  id: number;
  shop_id: number;
  parent_id: number | null;
  name: string;
  visibility_mode: 'all_b2b' | 'tiers' | 'companies';
  depth: number;
  created_at: number;
  deleted_at: number | null;
}

interface AssetRow {
  id: number;
  shop_id: number;
  folder_id: number | null;
  type: 'image' | 'pdf' | 'video' | 'link';
  title: string;
  description: string | null;
  r2_key: string | null;
  external_url: string | null;
  file_size_bytes: number | null;
  mime_type: string | null;
  visibility_mode: 'all_b2b' | 'tiers' | 'companies';
  uploaded_at: number;
  uploaded_by: string;
  deleted_at: number | null;
}

interface RuleRow {
  asset_id: number;
  rule_type: 'tier' | 'company';
  rule_target_id: string;
}

interface State {
  shop_exists: boolean;
  folders: Map<number, FolderRow>;
  next_folder_id: number;
  assets: Map<number, AssetRow>;
  next_asset_id: number;
  rules: RuleRow[];
}

function makeEnv(): { env: Env; state: State } {
  const state: State = {
    shop_exists: true,
    folders: new Map(),
    next_folder_id: 1,
    assets: new Map(),
    next_asset_id: 1,
    rules: [],
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
          if (sql.includes('SELECT id FROM shops')) {
            return state.shop_exists ? ({ id: SHOP_ID } as unknown as T) : null;
          }
          if (sql.includes('FROM asset_folders') && sql.includes('AND id = ?')) {
            const row = state.folders.get(bound[1] as number);
            return row && row.shop_id === bound[0] ? (row as unknown as T) : null;
          }
          if (sql.startsWith('INSERT INTO asset_folders')) {
            const id = state.next_folder_id++;
            const row: FolderRow = {
              id,
              shop_id: bound[0] as number,
              parent_id: bound[1] as number | null,
              name: bound[2] as string,
              visibility_mode: bound[3] as FolderRow['visibility_mode'],
              depth: bound[4] as number,
              created_at: bound[5] as number,
              deleted_at: null,
            };
            state.folders.set(id, row);
            return { id } as unknown as T;
          }
          if (sql.includes('FROM assets') && sql.includes('AND id = ?')) {
            const row = state.assets.get(bound[1] as number);
            return row && row.shop_id === bound[0] ? (row as unknown as T) : null;
          }
          if (sql.startsWith('INSERT INTO assets')) {
            const id = state.next_asset_id++;
            const row: AssetRow = {
              id,
              shop_id: bound[0] as number,
              folder_id: bound[1] as number | null,
              type: bound[2] as AssetRow['type'],
              title: bound[3] as string,
              description: bound[4] as string | null,
              r2_key: bound[5] as string | null,
              external_url: bound[6] as string | null,
              file_size_bytes: bound[7] as number | null,
              mime_type: bound[8] as string | null,
              visibility_mode: bound[9] as AssetRow['visibility_mode'],
              uploaded_at: bound[10] as number,
              uploaded_by: bound[11] as string,
              deleted_at: null,
            };
            state.assets.set(id, row);
            return { id } as unknown as T;
          }
          return null;
        },
        async run(): Promise<D1Result> {
          if (sql.startsWith('UPDATE asset_folders SET\n         name')) {
            const id = bound[3] as number;
            const shop_id = bound[2] as number;
            const row = state.folders.get(id);
            if (!row || row.shop_id !== shop_id || row.deleted_at !== null) {
              return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            row.name = bound[0] as string;
            row.visibility_mode = bound[1] as FolderRow['visibility_mode'];
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (sql.startsWith('UPDATE asset_folders SET deleted_at')) {
            const id = bound[2] as number;
            const shop_id = bound[1] as number;
            const row = state.folders.get(id);
            if (!row || row.shop_id !== shop_id || row.deleted_at !== null) {
              return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            row.deleted_at = bound[0] as number;
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (sql.startsWith('UPDATE assets SET deleted_at') && !sql.includes('IN (')) {
            const id = bound[2] as number;
            const shop_id = bound[1] as number;
            const row = state.assets.get(id);
            if (!row || row.shop_id !== shop_id || row.deleted_at !== null) {
              return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            row.deleted_at = bound[0] as number;
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (sql.startsWith('UPDATE assets SET deleted_at') && sql.includes('IN (')) {
            const now = bound[0] as number;
            const shop_id = bound[1] as number;
            const ids = bound.slice(2) as number[];
            let changes = 0;
            for (const id of ids) {
              const row = state.assets.get(id);
              if (row && row.shop_id === shop_id && row.deleted_at === null) {
                row.deleted_at = now;
                changes++;
              }
            }
            return { success: true, meta: { changes } } as unknown as D1Result;
          }
          if (sql.startsWith('UPDATE assets SET folder_id') && sql.includes('IN (')) {
            const folderId = bound[0] as number | null;
            const shop_id = bound[1] as number;
            const ids = bound.slice(2) as number[];
            let changes = 0;
            for (const id of ids) {
              const row = state.assets.get(id);
              if (row && row.shop_id === shop_id && row.deleted_at === null) {
                row.folder_id = folderId;
                changes++;
              }
            }
            return { success: true, meta: { changes } } as unknown as D1Result;
          }
          if (sql.startsWith('UPDATE assets SET visibility_mode')) {
            const mode = bound[0] as AssetRow['visibility_mode'];
            const shop_id = bound[1] as number;
            const ids = bound.slice(2) as number[];
            let changes = 0;
            for (const id of ids) {
              const row = state.assets.get(id);
              if (row && row.shop_id === shop_id && row.deleted_at === null) {
                row.visibility_mode = mode;
                changes++;
              }
            }
            return { success: true, meta: { changes } } as unknown as D1Result;
          }
          if (sql.startsWith('UPDATE assets')) {
            // single-asset metadata update
            const title = bound[0] as string;
            const description = bound[1] as string | null;
            const folder_id = bound[2] as number | null;
            const shop_id = bound[3] as number;
            const id = bound[4] as number;
            const row = state.assets.get(id);
            if (!row || row.shop_id !== shop_id || row.deleted_at !== null) {
              return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            row.title = title;
            row.description = description;
            row.folder_id = folder_id;
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (sql.startsWith('DELETE FROM asset_visibility_rules')) {
            const ids = bound as number[];
            state.rules = state.rules.filter(r => !ids.includes(r.asset_id));
            return { success: true, meta: { changes: 0 } } as unknown as D1Result;
          }
          if (sql.startsWith('INSERT INTO asset_visibility_rules')) {
            state.rules.push({
              asset_id: bound[0] as number,
              rule_type: bound[1] as 'tier' | 'company',
              rule_target_id: bound[2] as string,
            });
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          return { success: true, meta: { changes: 0 } } as unknown as D1Result;
        },
        async all<T>(): Promise<D1Result<T>> {
          if (sql.includes('FROM asset_folders')) {
            const results = Array.from(state.folders.values()).filter(
              f => f.shop_id === (bound[0] as number) && f.deleted_at === null,
            );
            return { results, success: true, meta: {} } as unknown as D1Result<T>;
          }
          if (sql.includes('FROM assets a') || sql.includes('FROM assets')) {
            const results = Array.from(state.assets.values()).filter(
              a => a.shop_id === (bound[0] as number) && a.deleted_at === null,
            );
            return { results, success: true, meta: {} } as unknown as D1Result<T>;
          }
          if (sql.includes('FROM asset_visibility_rules')) {
            const ids = bound as number[];
            const results = state.rules.filter(r => ids.includes(r.asset_id));
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

  const env: Env = {
    DB: db,
    KV_SESSIONS: {} as KVNamespace,
    KV_IDEMPOTENCY: {} as KVNamespace,
    KV_HOT_CACHE: {} as KVNamespace,
    ASSETS_BUCKET: {} as R2Bucket,
    WEBHOOK_QUEUE: {} as Queue,
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    MASTER_KEY: '00'.repeat(32),
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

describe('Admin folders', () => {
  let env: Env;
  let state: State;
  beforeEach(() => {
    ({ env, state } = makeEnv());
  });

  it('401 without Authorization', async () => {
    const app = buildApp(env);
    const res = await app.request('/admin/asset-folders', {}, env);
    expect(res.status).toBe(401);
  });

  it('creates a root folder at depth 0', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      '/admin/asset-folders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: null, name: 'Catalogs', visibility_mode: 'all_b2b' }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { folder: { id: number; depth: number } };
    expect(json.folder.depth).toBe(0);
    expect(state.folders.size).toBe(1);
  });

  it('creates a child folder at depth = parent.depth + 1', async () => {
    const app = buildApp(env);
    await authed(
      app,
      '/admin/asset-folders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: null, name: 'Root', visibility_mode: 'all_b2b' }),
      },
      env,
    );
    const res = await authed(
      app,
      '/admin/asset-folders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: 1, name: 'Child', visibility_mode: 'all_b2b' }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { folder: { depth: number } };
    expect(json.folder.depth).toBe(1);
  });

  it('rejects nesting beyond 3 levels deep', async () => {
    const app = buildApp(env);
    // depths 0, 1, 2 — all fine
    for (let i = 0; i < 3; i++) {
      await authed(
        app,
        '/admin/asset-folders',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parent_id: i === 0 ? null : i,
            name: `L${i}`,
            visibility_mode: 'all_b2b',
          }),
        },
        env,
      );
    }
    // Attempt depth 3
    const res = await authed(
      app,
      '/admin/asset-folders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: 3, name: 'L3', visibility_mode: 'all_b2b' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/3 levels/);
  });

  it('rejects invalid visibility_mode with 400', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      '/admin/asset-folders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: null, name: 'X', visibility_mode: 'public' }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('soft-deletes a folder', async () => {
    const app = buildApp(env);
    await authed(
      app,
      '/admin/asset-folders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: null, name: 'Catalogs', visibility_mode: 'all_b2b' }),
      },
      env,
    );
    const res = await authed(app, '/admin/asset-folders/1', { method: 'DELETE' }, env);
    expect(res.status).toBe(200);
    expect(state.folders.get(1)?.deleted_at).not.toBeNull();
  });
});

describe('Admin assets', () => {
  let env: Env;
  let state: State;
  beforeEach(() => {
    ({ env, state } = makeEnv());
  });

  it('creates a link asset', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      '/admin/assets',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder_id: null,
          type: 'link',
          title: 'Dropbox folder',
          external_url: 'https://www.dropbox.com/sh/abc',
          visibility_mode: 'all_b2b',
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { asset: { id: number; type: string } };
    expect(json.asset.type).toBe('link');
  });

  it('rejects an asset whose r2_key belongs to another shop', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      '/admin/assets',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder_id: null,
          type: 'pdf',
          title: 'Price list',
          r2_key: 'shops/999/assets/1/original',
          mime_type: 'application/pdf',
          file_size_bytes: 1024,
          visibility_mode: 'all_b2b',
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/shop/);
  });

  it('rejects video larger than 500MB', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      '/admin/assets',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder_id: null,
          type: 'video',
          title: 'Big demo',
          r2_key: 'shops/7/assets/x/original',
          mime_type: 'video/mp4',
          file_size_bytes: 600 * 1024 * 1024,
          visibility_mode: 'all_b2b',
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('writes visibility rules when mode=tiers', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      '/admin/assets',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder_id: null,
          type: 'pdf',
          title: 'Gold-only price list',
          r2_key: 'shops/7/assets/x/original',
          mime_type: 'application/pdf',
          file_size_bytes: 1024,
          visibility_mode: 'tiers',
          rules: [{ rule_type: 'tier', rule_target_id: '3' }],
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]).toMatchObject({ rule_type: 'tier', rule_target_id: '3' });
  });

  it('rejects tier-visibility without rules', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      '/admin/assets',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder_id: null,
          type: 'pdf',
          title: 'X',
          r2_key: 'shops/7/assets/x/original',
          mime_type: 'application/pdf',
          file_size_bytes: 1024,
          visibility_mode: 'tiers',
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('bulk-move updates folder_id', async () => {
    const app = buildApp(env);
    for (let i = 0; i < 3; i++) {
      await authed(
        app,
        '/admin/assets',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folder_id: null,
            type: 'pdf',
            title: `A${i}`,
            r2_key: `shops/7/assets/${i}/original`,
            mime_type: 'application/pdf',
            file_size_bytes: 1024,
            visibility_mode: 'all_b2b',
          }),
        },
        env,
      );
    }
    const res = await authed(
      app,
      '/admin/assets/bulk-move',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_ids: [1, 2, 3], folder_id: 42 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { moved: number };
    expect(json.moved).toBe(3);
    expect(state.assets.get(1)?.folder_id).toBe(42);
  });

  it('bulk-delete soft-deletes assets', async () => {
    const app = buildApp(env);
    for (let i = 0; i < 2; i++) {
      await authed(
        app,
        '/admin/assets',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folder_id: null,
            type: 'pdf',
            title: `A${i}`,
            r2_key: `shops/7/assets/${i}/original`,
            mime_type: 'application/pdf',
            file_size_bytes: 1024,
            visibility_mode: 'all_b2b',
          }),
        },
        env,
      );
    }
    const res = await authed(
      app,
      '/admin/assets/bulk-delete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_ids: [1, 2] }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(state.assets.get(1)?.deleted_at).not.toBeNull();
    expect(state.assets.get(2)?.deleted_at).not.toBeNull();
  });

  it('bulk-visibility only accepts all_b2b', async () => {
    const app = buildApp(env);
    await authed(
      app,
      '/admin/assets',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder_id: null,
          type: 'pdf',
          title: 'A',
          r2_key: 'shops/7/assets/1/original',
          mime_type: 'application/pdf',
          file_size_bytes: 1024,
          visibility_mode: 'all_b2b',
        }),
      },
      env,
    );
    const res = await authed(
      app,
      '/admin/assets/bulk-visibility',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_ids: [1], visibility_mode: 'tiers' }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('upload session start requires allowed mime', async () => {
    const app = buildApp(env);
    const res = await authed(
      app,
      '/admin/assets/uploads',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'malware.exe',
          mime_type: 'application/x-msdownload',
          total_size_bytes: 1024,
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});
