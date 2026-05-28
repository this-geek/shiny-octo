import { describe, it, expect } from 'vitest';
import { runGdprSweep } from './gdpr-sweep.js';
import {
  CUSTOMER_REDACT_GRACE_S,
  DATA_REQUEST_GRACE_S,
  SHOP_REDACT_GRACE_S,
  getGdprRequest,
  insertGdprRequest,
} from '../lib/gdpr-store.js';
import { encryptForm } from '../lib/application-store.js';
import { hashIdAsync } from '../lib/logger.js';
import type { Env } from '../types.js';

/**
 * Integration-style: real `lib/gdpr-store` + `lib/gdpr-purge` against
 * hand-rolled D1/R2/KV fakes. Asserts the sweep dispatches by kind and
 * leaves not-yet-due rows alone.
 */

const NOW = 1_700_000_000;
const SHOP_DOMAIN = 'acme.myshopify.com';
const MASTER_KEY = '00'.repeat(32);

interface GdprRowMem {
  id: string;
  shop_id: number | null;
  shop_domain: string;
  kind: string;
  shopify_customer_id: string | null;
  payload_json: string;
  received_at: number;
  due_at: number;
  status: string;
  completed_at: number | null;
  last_error: string | null;
}
interface ShopMem {
  id: number;
  shopify_domain: string;
}
interface AppMem {
  id: number;
  shop_id: number;
  shopify_customer_id: string | null;
  form_data_encrypted: string;
  email: string;
  status: string;
  submitted_at: number | null;
  decided_at: number | null;
  decision_notes: string | null;
  created_company_id: string | null;
  created_location_id: string | null;
}

interface State {
  shops: ShopMem[];
  applications: AppMem[];
  gdpr_requests: GdprRowMem[];
  application_nudges: Array<{ application_id: number; kind: string }>;
  asset_downloads: Array<{
    id: number;
    shop_id: number;
    shopify_customer_id: string;
    asset_id: number;
    shopify_company_id: string;
    downloaded_at: number;
  }>;
  assets: Array<{ id: number; shop_id: number }>;
  asset_visibility_rules: Array<{ asset_id: number }>;
  asset_folders: Array<{ id: number; shop_id: number }>;
  tiers: Array<{ id: number; shop_id: number }>;
  company_tier_mappings: Array<{ shop_id: number; shopify_company_id: string }>;
  webhook_log: Array<{ id: string; shop_id: number }>;
  queue: Array<{ topic: string; body: string }>;
}

function emptyState(): State {
  return {
    shops: [],
    applications: [],
    gdpr_requests: [],
    application_nudges: [],
    asset_downloads: [],
    assets: [],
    asset_visibility_rules: [],
    asset_folders: [],
    tiers: [],
    company_tier_mappings: [],
    webhook_log: [],
    queue: [],
  };
}

function fakeDb(state: State): D1Database {
  return {
    prepare(rawSql: string) {
      let bound: unknown[] = [];
      const sql = rawSql.replace(/\s+/g, ' ').trim();
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.startsWith('SELECT * FROM gdpr_requests WHERE id = ?')) {
            const [id] = bound as [string];
            return (state.gdpr_requests.find(r => r.id === id) as unknown as T) ?? null;
          }
          if (sql.startsWith('SELECT id FROM shops WHERE shopify_domain = ?')) {
            const [d] = bound as [string];
            const s = state.shops.find(r => r.shopify_domain === d);
            return s ? ({ id: s.id } as unknown as T) : null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.startsWith("SELECT * FROM gdpr_requests WHERE status = 'pending' AND due_at <= ?")) {
            const [now, limit] = bound as [number, number];
            const out = state.gdpr_requests
              .filter(r => r.status === 'pending' && r.due_at <= now)
              .sort((a, b) => a.due_at - b.due_at)
              .slice(0, limit);
            return { results: out as unknown as T[] };
          }
          if (
            sql.startsWith('SELECT id, email, status') &&
            sql.includes('FROM applications') &&
            sql.includes('shop_id = ? AND shopify_customer_id = ?')
          ) {
            const [shopId, cust] = bound as [number, string];
            const rows = state.applications.filter(
              a => a.shop_id === shopId && a.shopify_customer_id === cust,
            );
            return { results: rows as unknown as T[] };
          }
          if (
            sql.startsWith('SELECT id FROM applications') &&
            sql.includes('shop_id = ? AND shopify_customer_id = ?')
          ) {
            const [shopId, cust] = bound as [number, string];
            const rows = state.applications
              .filter(a => a.shop_id === shopId && a.shopify_customer_id === cust)
              .map(a => ({ id: a.id }));
            return { results: rows as unknown as T[] };
          }
          if (
            sql.startsWith('SELECT asset_id') &&
            sql.includes('FROM asset_downloads')
          ) {
            const [shopId, hash] = bound as [number, string];
            const rows = state.asset_downloads.filter(
              d => d.shop_id === shopId && d.shopify_customer_id === hash,
            );
            return { results: rows as unknown as T[] };
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
              string,
              string | null,
              string,
              number,
              number,
            ];
            if (state.gdpr_requests.some(r => r.id === id)) return m(0);
            state.gdpr_requests.push({
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
          if (sql.includes("UPDATE gdpr_requests SET status = 'processing'")) {
            const [id] = bound as [string];
            const row = state.gdpr_requests.find(r => r.id === id);
            if (!row || row.status !== 'pending') return m(0);
            row.status = 'processing';
            return m(1);
          }
          if (sql.includes("status = 'completed'")) {
            const [completedAt, id] = bound as [number, string];
            const row = state.gdpr_requests.find(r => r.id === id);
            if (!row) return m(0);
            row.status = 'completed';
            row.completed_at = completedAt;
            return m(1);
          }
          if (sql.includes("status = 'failed'")) {
            const [err, id] = bound as [string, string];
            const row = state.gdpr_requests.find(r => r.id === id);
            if (!row) return m(0);
            row.status = 'failed';
            row.last_error = err;
            return m(1);
          }
          if (sql.startsWith('DELETE FROM application_nudges') && sql.includes('SELECT id FROM applications')) {
            const [shopId] = bound as [number];
            const ids = new Set(
              state.applications.filter(a => a.shop_id === shopId).map(a => a.id),
            );
            const before = state.application_nudges.length;
            state.application_nudges = state.application_nudges.filter(
              n => !ids.has(n.application_id),
            );
            return m(before - state.application_nudges.length);
          }
          if (sql.startsWith('DELETE FROM application_nudges WHERE application_id IN')) {
            const ids = new Set(bound as number[]);
            const before = state.application_nudges.length;
            state.application_nudges = state.application_nudges.filter(
              n => !ids.has(n.application_id),
            );
            return m(before - state.application_nudges.length);
          }
          if (sql.startsWith('DELETE FROM applications WHERE shop_id = ? AND id IN')) {
            const [shopId, ...ids] = bound as [number, ...number[]];
            const idSet = new Set(ids);
            const before = state.applications.length;
            state.applications = state.applications.filter(
              a => !(a.shop_id === shopId && idSet.has(a.id)),
            );
            return m(before - state.applications.length);
          }
          if (sql.startsWith('DELETE FROM asset_downloads WHERE shop_id = ? AND shopify_customer_id = ?')) {
            const [shopId, hash] = bound as [number, string];
            const before = state.asset_downloads.length;
            state.asset_downloads = state.asset_downloads.filter(
              d => !(d.shop_id === shopId && d.shopify_customer_id === hash),
            );
            return m(before - state.asset_downloads.length);
          }
          if (sql.startsWith('DELETE FROM asset_visibility_rules') && sql.includes('SELECT id FROM assets')) {
            const [shopId] = bound as [number];
            const ids = new Set(
              state.assets.filter(a => a.shop_id === shopId).map(a => a.id),
            );
            const before = state.asset_visibility_rules.length;
            state.asset_visibility_rules = state.asset_visibility_rules.filter(
              v => !ids.has(v.asset_id),
            );
            return m(before - state.asset_visibility_rules.length);
          }
          const simple = sql.match(/^DELETE FROM (\w+) WHERE shop_id = \?$/);
          if (simple) {
            const [shopId] = bound as [number];
            const tbl = simple[1] as keyof State;
            const arr = state[tbl] as Array<{ shop_id: number }>;
            const before = arr.length;
            const kept = arr.filter(r => r.shop_id !== shopId);
            (state[tbl] as unknown[]).length = 0;
            (state[tbl] as unknown[]).push(...kept);
            return m(before - kept.length);
          }
          if (sql === 'DELETE FROM shops WHERE id = ?') {
            const [id] = bound as [number];
            const before = state.shops.length;
            state.shops = state.shops.filter(s => s.id !== id);
            return m(before - state.shops.length);
          }
          throw new Error(`unhandled run in test: ${sql}`);
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function fakeR2() {
  let objs: Array<{ key: string }> = [];
  return {
    bucket: {
      async list() {
        return { objects: [...objs], truncated: false };
      },
      async delete(keys: string | string[]) {
        const arr = Array.isArray(keys) ? keys : [keys];
        objs = objs.filter(o => !arr.includes(o.key));
      },
    } as unknown as R2Bucket,
  };
}

function fakeKv() {
  return {
    async get() {
      return null;
    },
    async put() {},
    async delete() {},
    async list() {
      return { keys: [], list_complete: true, cursor: '' };
    },
  } as unknown as KVNamespace;
}

function fakeQueue(state: State): Queue {
  return {
    send: async (msg: { topic: string; body: string }) => {
      state.queue.push({ topic: msg.topic, body: msg.body });
    },
  } as unknown as Queue;
}

async function makeEnv(): Promise<{ env: Env; state: State }> {
  const state = emptyState();
  const env: Env = {
    DB: fakeDb(state),
    KV_SESSIONS: fakeKv(),
    KV_IDEMPOTENCY: fakeKv(),
    KV_HOT_CACHE: fakeKv(),
    ASSETS_BUCKET: fakeR2().bucket,
    WEBHOOK_QUEUE: fakeQueue(state),
    SHOPIFY_API_KEY: '',
    SHOPIFY_API_SECRET: '',
    MASTER_KEY,
    RESEND_API_KEY: '',
    APP_URL: '',
    SHOPIFY_API_VERSION: '2026-04',
    ADMIN_ORIGIN: '',
  };
  return { env, state };
}

describe('runGdprSweep', () => {
  it('processes due rows and skips future rows', async () => {
    const { env, state } = await makeEnv();
    state.shops.push({ id: 7, shopify_domain: SHOP_DOMAIN });

    await insertGdprRequest(env.DB, {
      id: 'past-shop-redact',
      shop_id: 7,
      shop_domain: SHOP_DOMAIN,
      kind: 'shop_redact',
      shopify_customer_id: null,
      payload_json: '{}',
      received_at: NOW - SHOP_REDACT_GRACE_S - 10,
      due_at: NOW - 10,
    });
    await insertGdprRequest(env.DB, {
      id: 'future-redact',
      shop_id: 7,
      shop_domain: SHOP_DOMAIN,
      kind: 'shop_redact',
      shopify_customer_id: null,
      payload_json: '{}',
      received_at: NOW,
      due_at: NOW + 100,
    });

    const result = await runGdprSweep(env, NOW);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    const done = await getGdprRequest(env.DB, 'past-shop-redact');
    expect(done?.status).toBe('completed');
    const future = await getGdprRequest(env.DB, 'future-redact');
    expect(future?.status).toBe('pending');
    expect(state.shops).toEqual([]);
  });

  it('dispatches customer_redact through redactCustomer', async () => {
    const { env, state } = await makeEnv();
    state.shops.push({ id: 7, shopify_domain: SHOP_DOMAIN });
    const form = await encryptForm(
      { fields: {}, email: 'b@e.com', documents: [] },
      SHOP_DOMAIN,
      MASTER_KEY,
    );
    state.applications.push({
      id: 1,
      shop_id: 7,
      shopify_customer_id: '101',
      form_data_encrypted: form,
      email: 'b@e.com',
      status: 'approved',
      submitted_at: 1,
      decided_at: 2,
      decision_notes: null,
      created_company_id: null,
      created_location_id: null,
    });
    const hash = await hashIdAsync('101');
    state.asset_downloads.push({
      id: 1,
      shop_id: 7,
      shopify_customer_id: hash,
      asset_id: 9,
      shopify_company_id: 'gid://shopify/Company/1',
      downloaded_at: 100,
    });

    await insertGdprRequest(env.DB, {
      id: 'cust-redact',
      shop_id: 7,
      shop_domain: SHOP_DOMAIN,
      kind: 'customer_redact',
      shopify_customer_id: '101',
      payload_json: '{}',
      received_at: NOW - CUSTOMER_REDACT_GRACE_S - 1,
      due_at: NOW - 1,
    });

    const result = await runGdprSweep(env, NOW);
    expect(result.processed).toBe(1);
    expect(state.applications).toEqual([]);
    expect(state.asset_downloads).toEqual([]);
    const row = await getGdprRequest(env.DB, 'cust-redact');
    expect(row?.status).toBe('completed');
  });

  it('enqueues an export job for customer_data_request rather than running inline', async () => {
    const { env, state } = await makeEnv();
    state.shops.push({ id: 7, shopify_domain: SHOP_DOMAIN });

    await insertGdprRequest(env.DB, {
      id: 'cust-export',
      shop_id: 7,
      shop_domain: SHOP_DOMAIN,
      kind: 'customer_data_request',
      shopify_customer_id: '101',
      payload_json: '{}',
      received_at: NOW - DATA_REQUEST_GRACE_S,
      due_at: NOW,
    });

    const result = await runGdprSweep(env, NOW);
    expect(result.processed).toBe(1);
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].topic).toBe('_internal/send-gdpr-export');
    expect(JSON.parse(state.queue[0].body)).toEqual({ gdpr_request_id: 'cust-export' });
    const row = await getGdprRequest(env.DB, 'cust-export');
    expect(row?.status).toBe('completed');
  });

  it('marks rows failed and records the error message', async () => {
    const { env } = await makeEnv();
    // No shops row → customer_redact with shop_id=null → handler logs and
    // returns without throwing. Use a bad-kind path instead: missing
    // shopify_customer_id on a customer_redact triggers a throw.
    await insertGdprRequest(env.DB, {
      id: 'broken',
      shop_id: 7,
      shop_domain: SHOP_DOMAIN,
      kind: 'customer_redact',
      shopify_customer_id: null,
      payload_json: '{}',
      received_at: NOW - 10,
      due_at: NOW - 1,
    });
    const result = await runGdprSweep(env, NOW);
    expect(result.failed).toBe(1);
    const row = await getGdprRequest(env.DB, 'broken');
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toContain('missing customer id');
  });
});
