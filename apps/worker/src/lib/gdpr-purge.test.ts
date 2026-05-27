import { describe, it, expect, beforeEach } from 'vitest';
import { exportCustomerData, redactCustomer, redactShop } from './gdpr-purge.js';
import { encryptForm } from './application-store.js';
import { hashIdAsync } from './logger.js';
import type { Env } from '../types.js';

/**
 * Hand-rolled fakes for D1 / R2 / KV. The asset-store style mocks use the
 * same approach. Mocks only model the DELETE / SELECT paths the code under
 * test exercises; anything else throws so missing coverage is loud.
 */

interface ShopRow {
  id: number;
  shopify_domain: string;
}
interface AppRow {
  id: number;
  shop_id: number;
  email: string;
  status: string;
  submitted_at: number | null;
  decided_at: number | null;
  decision_notes: string | null;
  created_company_id: string | null;
  created_location_id: string | null;
  shopify_customer_id: string | null;
  form_data_encrypted: string;
}
interface DownloadRow {
  id: number;
  shop_id: number;
  asset_id: number;
  shopify_company_id: string;
  shopify_customer_id: string; // hashed
  downloaded_at: number;
  ip_hash: string;
}
interface NudgeRow {
  application_id: number;
  kind: string;
  sent_at: number;
}
interface AssetRow {
  id: number;
  shop_id: number;
}
interface AvrRow {
  asset_id: number;
  rule_type: string;
  rule_target_id: string;
}
interface FolderRow {
  id: number;
  shop_id: number;
}
interface MappingRow {
  shop_id: number;
  shopify_company_id: string;
}
interface TierRow {
  id: number;
  shop_id: number;
}
interface WebhookLogRow {
  id: string;
  shop_id: number;
}

interface Tables {
  shops: ShopRow[];
  applications: AppRow[];
  asset_downloads: DownloadRow[];
  application_nudges: NudgeRow[];
  assets: AssetRow[];
  asset_visibility_rules: AvrRow[];
  asset_folders: FolderRow[];
  company_tier_mappings: MappingRow[];
  tiers: TierRow[];
  webhook_log: WebhookLogRow[];
}

function emptyTables(): Tables {
  return {
    shops: [],
    applications: [],
    asset_downloads: [],
    application_nudges: [],
    assets: [],
    asset_visibility_rules: [],
    asset_folders: [],
    company_tier_mappings: [],
    tiers: [],
    webhook_log: [],
  };
}

function fakeDb(tables: Tables): D1Database {
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (
            sql.includes('FROM applications') &&
            sql.includes('shop_id = ? AND shopify_customer_id = ?') &&
            sql.includes('form_data_encrypted')
          ) {
            const [shopId, cust] = bound as [number, string];
            const rows = tables.applications.filter(
              a => a.shop_id === shopId && a.shopify_customer_id === cust,
            );
            return { results: rows as unknown as T[] };
          }
          if (
            sql.includes('FROM applications') &&
            sql.includes('shop_id = ? AND shopify_customer_id = ?')
          ) {
            const [shopId, cust] = bound as [number, string];
            const rows = tables.applications
              .filter(a => a.shop_id === shopId && a.shopify_customer_id === cust)
              .map(a => ({ id: a.id }));
            return { results: rows as unknown as T[] };
          }
          if (
            sql.includes('FROM asset_downloads') &&
            sql.includes('shop_id = ? AND shopify_customer_id = ?')
          ) {
            const [shopId, hash] = bound as [number, string];
            const rows = tables.asset_downloads.filter(
              d => d.shop_id === shopId && d.shopify_customer_id === hash,
            );
            return { results: rows as unknown as T[] };
          }
          throw new Error(`unhandled SELECT in test: ${sql}`);
        },
        async run() {
          const m = (changes: number) => ({
            success: true,
            meta: { changes },
          } as unknown as D1Result);
          // Normalise whitespace so multi-line SQL matches the same as single-line.
          sql = sql.replace(/\s+/g, ' ').trim();

          // Order matters: the SELECT-subquery form must be matched before
          // the literal-IN form (both start with the same prefix).
          if (
            sql.startsWith('DELETE FROM application_nudges') &&
            sql.includes('SELECT id FROM applications')
          ) {
            const [shopId] = bound as [number];
            const appIds = new Set(
              tables.applications.filter(a => a.shop_id === shopId).map(a => a.id),
            );
            const before = tables.application_nudges.length;
            tables.application_nudges = tables.application_nudges.filter(
              n => !appIds.has(n.application_id),
            );
            return m(before - tables.application_nudges.length);
          }
          if (sql.startsWith('DELETE FROM application_nudges WHERE application_id IN')) {
            const ids = new Set(bound as number[]);
            const before = tables.application_nudges.length;
            tables.application_nudges = tables.application_nudges.filter(
              n => !ids.has(n.application_id),
            );
            return m(before - tables.application_nudges.length);
          }
          if (sql.startsWith('DELETE FROM applications WHERE shop_id = ? AND id IN')) {
            const [shopId, ...ids] = bound as [number, ...number[]];
            const idSet = new Set(ids);
            const before = tables.applications.length;
            tables.applications = tables.applications.filter(
              a => !(a.shop_id === shopId && idSet.has(a.id)),
            );
            return m(before - tables.applications.length);
          }
          if (sql.startsWith('DELETE FROM asset_downloads WHERE shop_id = ? AND shopify_customer_id = ?')) {
            const [shopId, hash] = bound as [number, string];
            const before = tables.asset_downloads.length;
            tables.asset_downloads = tables.asset_downloads.filter(
              d => !(d.shop_id === shopId && d.shopify_customer_id === hash),
            );
            return m(before - tables.asset_downloads.length);
          }
          if (
            sql.startsWith('DELETE FROM asset_visibility_rules') &&
            sql.includes('SELECT id FROM assets')
          ) {
            const [shopId] = bound as [number];
            const assetIds = new Set(
              tables.assets.filter(a => a.shop_id === shopId).map(a => a.id),
            );
            const before = tables.asset_visibility_rules.length;
            tables.asset_visibility_rules = tables.asset_visibility_rules.filter(
              v => !assetIds.has(v.asset_id),
            );
            return m(before - tables.asset_visibility_rules.length);
          }
          // Simple per-table "WHERE shop_id = ?" deletes.
          const simple = sql.match(/^DELETE FROM (\w+) WHERE shop_id = \?$/);
          if (simple) {
            const [shopId] = bound as [number];
            const tbl = simple[1] as keyof Tables;
            const arr = tables[tbl] as Array<{ shop_id: number }>;
            const before = arr.length;
            const kept = arr.filter(r => r.shop_id !== shopId);
            // Replace in place
            (tables[tbl] as unknown[]).length = 0;
            (tables[tbl] as unknown[]).push(...kept);
            return m(before - kept.length);
          }
          if (sql === 'DELETE FROM shops WHERE id = ?') {
            const [id] = bound as [number];
            const before = tables.shops.length;
            tables.shops = tables.shops.filter(s => s.id !== id);
            return m(before - tables.shops.length);
          }
          throw new Error(`unhandled run in test: ${sql}`);
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

interface R2Object {
  key: string;
  body: Uint8Array;
}

function fakeR2(seed: R2Object[] = []) {
  let objects: R2Object[] = [...seed];
  return {
    bucket: {
      async list({
        prefix,
        cursor,
        limit,
      }: {
        prefix?: string;
        cursor?: string;
        limit?: number;
      } = {}) {
        const matching = objects.filter(o => !prefix || o.key.startsWith(prefix));
        const start = cursor ? Number.parseInt(cursor, 10) : 0;
        const slice = matching.slice(start, start + (limit ?? 1000));
        const nextStart = start + slice.length;
        const truncated = nextStart < matching.length;
        return {
          objects: slice.map(o => ({ key: o.key })),
          truncated,
          cursor: truncated ? String(nextStart) : undefined,
        };
      },
      async delete(keys: string | string[]) {
        const arr = Array.isArray(keys) ? keys : [keys];
        objects = objects.filter(o => !arr.includes(o.key));
      },
      put: async () => null,
      get: async () => null,
      head: async () => null,
      createMultipartUpload: async () => null,
      resumeMultipartUpload: () => null,
    } as unknown as R2Bucket,
    snapshot: () => [...objects.map(o => o.key)],
  };
}

function fakeKv(seed: Record<string, string> = {}) {
  let store = { ...seed };
  return {
    namespace: {
      async get(key: string) {
        return store[key] ?? null;
      },
      async put(key: string, value: string) {
        store[key] = value;
      },
      async delete(key: string) {
        delete store[key];
      },
      async list({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) {
        const keys = Object.keys(store).filter(k => !prefix || k.startsWith(prefix));
        const start = cursor ? Number.parseInt(cursor, 10) : 0;
        const slice = keys.slice(start, start + 1000);
        const nextStart = start + slice.length;
        return {
          keys: slice.map(name => ({ name })),
          list_complete: nextStart >= keys.length,
          cursor: String(nextStart),
        };
      },
    } as unknown as KVNamespace,
    snapshot: () => ({ ...store }),
  };
}

const SHOP_DOMAIN = 'acme.myshopify.com';
const OTHER_SHOP_DOMAIN = 'bystander.myshopify.com';
const MASTER_KEY = '00'.repeat(32);

interface Harness {
  env: Env;
  tables: Tables;
  r2Keys: () => string[];
  kvKeys: () => Record<string, string>;
}

async function seedHarness(): Promise<Harness> {
  const tables = emptyTables();
  tables.shops.push(
    { id: 7, shopify_domain: SHOP_DOMAIN },
    { id: 99, shopify_domain: OTHER_SHOP_DOMAIN },
  );

  // Shop 7 customer 101 — the buyer being acted on.
  const targetForm = await encryptForm(
    {
      fields: { businessName: 'Acme' },
      email: 'buyer@example.com',
      companyName: 'Acme Ltd',
      documents: [
        {
          name: 'license.pdf',
          r2_key: 'shops/7/applications/1/license.pdf',
          size: 1024,
          mime: 'application/pdf',
        },
      ],
    },
    SHOP_DOMAIN,
    MASTER_KEY,
  );
  tables.applications.push({
    id: 1,
    shop_id: 7,
    email: 'buyer@example.com',
    status: 'approved',
    submitted_at: 1000,
    decided_at: 2000,
    decision_notes: null,
    created_company_id: 'gid://shopify/Company/1',
    created_location_id: 'gid://shopify/CompanyLocation/1',
    shopify_customer_id: '101',
    form_data_encrypted: targetForm,
  });
  tables.application_nudges.push({ application_id: 1, kind: 'nudge_14d', sent_at: 3000 });

  const targetHash = await hashIdAsync('101');
  tables.asset_downloads.push({
    id: 1,
    shop_id: 7,
    asset_id: 10,
    shopify_company_id: 'gid://shopify/Company/1',
    shopify_customer_id: targetHash,
    downloaded_at: 2500,
    ip_hash: 'h',
  });

  // Shop 7 bystander customer 202 — must survive a redact of 101.
  const bystanderForm = await encryptForm(
    { fields: {}, email: 'other@example.com', documents: [] },
    SHOP_DOMAIN,
    MASTER_KEY,
  );
  tables.applications.push({
    id: 2,
    shop_id: 7,
    email: 'other@example.com',
    status: 'approved',
    submitted_at: 1000,
    decided_at: 2000,
    decision_notes: null,
    created_company_id: null,
    created_location_id: null,
    shopify_customer_id: '202',
    form_data_encrypted: bystanderForm,
  });
  const otherHash = await hashIdAsync('202');
  tables.asset_downloads.push({
    id: 2,
    shop_id: 7,
    asset_id: 10,
    shopify_company_id: 'gid://shopify/Company/1',
    shopify_customer_id: otherHash,
    downloaded_at: 2500,
    ip_hash: 'h',
  });

  // Shop 99 — cross-tenant bystander, must survive every operation.
  const crossForm = await encryptForm(
    { fields: {}, email: 'cross@example.com', documents: [] },
    OTHER_SHOP_DOMAIN,
    MASTER_KEY,
  );
  tables.applications.push({
    id: 3,
    shop_id: 99,
    email: 'cross@example.com',
    status: 'approved',
    submitted_at: 1000,
    decided_at: 2000,
    decision_notes: null,
    created_company_id: null,
    created_location_id: null,
    shopify_customer_id: '101', // same Shopify customer id but different shop
    form_data_encrypted: crossForm,
  });

  // Aux rows that shop_redact must clean up.
  tables.assets.push({ id: 10, shop_id: 7 }, { id: 20, shop_id: 99 });
  tables.asset_visibility_rules.push(
    { asset_id: 10, rule_type: 'tier', rule_target_id: '1' },
    { asset_id: 20, rule_type: 'tier', rule_target_id: '1' },
  );
  tables.asset_folders.push({ id: 1, shop_id: 7 }, { id: 2, shop_id: 99 });
  tables.tiers.push({ id: 1, shop_id: 7 }, { id: 2, shop_id: 99 });
  tables.company_tier_mappings.push(
    { shop_id: 7, shopify_company_id: 'gid://shopify/Company/1' },
    { shop_id: 99, shopify_company_id: 'gid://shopify/Company/2' },
  );
  tables.webhook_log.push(
    { id: 'wh-a', shop_id: 7 },
    { id: 'wh-b', shop_id: 99 },
  );

  const r2 = fakeR2([
    { key: 'shops/7/applications/1/license.pdf', body: new Uint8Array() },
    { key: 'shops/7/assets/10/original', body: new Uint8Array() },
    { key: 'shops/99/applications/3/other.pdf', body: new Uint8Array() },
  ]);

  const kv = fakeKv({
    [`tier:7:${targetHash}`]: '{"b2b":true}',
    [`tier:7:${otherHash}`]: '{"b2b":true}',
    [`tier:99:${targetHash}`]: '{"b2b":true}', // cross-tenant key — must survive shop 7 actions
    'unrelated:key': 'leave-me',
  });

  const env: Env = {
    DB: fakeDb(tables),
    KV_SESSIONS: fakeKv().namespace,
    KV_IDEMPOTENCY: fakeKv().namespace,
    KV_HOT_CACHE: kv.namespace,
    ASSETS_BUCKET: r2.bucket,
    WEBHOOK_QUEUE: { send: async () => {} } as unknown as Queue,
    SHOPIFY_API_KEY: '',
    SHOPIFY_API_SECRET: '',
    MASTER_KEY,
    RESEND_API_KEY: '',
    APP_URL: '',
    SHOPIFY_API_VERSION: '2026-04',
    ADMIN_ORIGIN: '',
  };

  return {
    env,
    tables,
    r2Keys: () => r2.snapshot(),
    kvKeys: () => kv.snapshot(),
  };
}

describe('exportCustomerData', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await seedHarness();
  });

  it('returns the buyer\'s decrypted application + download history + document refs', async () => {
    const bundle = await exportCustomerData(h.env, 7, SHOP_DOMAIN, '101', 5000);
    expect(bundle.shop_id).toBe(7);
    expect(bundle.shopify_customer_id).toBe('101');
    expect(bundle.applications).toHaveLength(1);
    expect(bundle.applications[0].id).toBe(1);
    expect(bundle.applications[0].email).toBe('buyer@example.com');
    expect(bundle.asset_downloads).toHaveLength(1);
    expect(bundle.documents).toEqual([
      { r2_key: 'shops/7/applications/1/license.pdf', size_bytes: 1024 },
    ]);
  });

  it('does not return another customer\'s rows', async () => {
    const bundle = await exportCustomerData(h.env, 7, SHOP_DOMAIN, '202');
    expect(bundle.applications.map(a => a.email)).toEqual(['other@example.com']);
  });

  it('does not cross shop boundaries (same customer id, different shop)', async () => {
    const bundle = await exportCustomerData(h.env, 7, SHOP_DOMAIN, '101');
    // application id 3 belongs to shop 99 — must not appear in shop 7's export
    expect(bundle.applications.map(a => a.id)).toEqual([1]);
  });
});

describe('redactCustomer', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await seedHarness();
  });

  it('deletes the target\'s applications, nudges, downloads, R2 docs, and KV cache', async () => {
    const result = await redactCustomer(h.env, 7, '101');
    expect(result.applications_deleted).toBe(1);
    expect(result.asset_downloads_deleted).toBe(1);
    expect(result.r2_objects_deleted).toBe(1);
    expect(result.kv_keys_deleted).toBe(1);

    expect(h.tables.applications.map(a => a.id)).toEqual([2, 3]);
    expect(h.tables.application_nudges).toEqual([]);
    expect(h.tables.asset_downloads.map(d => d.id)).toEqual([2]);
    expect(h.r2Keys()).not.toContain('shops/7/applications/1/license.pdf');
    const targetHash = await hashIdAsync('101');
    expect(h.kvKeys()[`tier:7:${targetHash}`]).toBeUndefined();
  });

  it('leaves the same-shop bystander untouched', async () => {
    await redactCustomer(h.env, 7, '101');
    const otherHash = await hashIdAsync('202');
    expect(h.tables.applications.some(a => a.id === 2)).toBe(true);
    expect(h.tables.asset_downloads.some(d => d.id === 2)).toBe(true);
    expect(h.kvKeys()[`tier:7:${otherHash}`]).toBe('{"b2b":true}');
  });

  it('does not touch a different shop holding the same Shopify customer id', async () => {
    await redactCustomer(h.env, 7, '101');
    expect(h.tables.applications.some(a => a.id === 3)).toBe(true);
    expect(h.r2Keys()).toContain('shops/99/applications/3/other.pdf');
    const targetHash = await hashIdAsync('101');
    expect(h.kvKeys()[`tier:99:${targetHash}`]).toBe('{"b2b":true}');
  });

  it('is a no-op for an unknown customer id', async () => {
    const result = await redactCustomer(h.env, 7, 'unknown-customer');
    expect(result.applications_deleted).toBe(0);
    expect(result.asset_downloads_deleted).toBe(0);
    expect(result.r2_objects_deleted).toBe(0);
  });
});

describe('redactShop', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await seedHarness();
  });

  it('purges every PII-bearing table, R2 prefix, and KV cache for the shop', async () => {
    const result = await redactShop(h.env, 7);
    expect(result.rows_deleted.applications).toBe(2);
    expect(result.rows_deleted.asset_downloads).toBe(2);
    expect(result.rows_deleted.application_nudges).toBe(1);
    expect(result.rows_deleted.asset_visibility_rules).toBe(1);
    expect(result.rows_deleted.assets).toBe(1);
    expect(result.rows_deleted.asset_folders).toBe(1);
    expect(result.rows_deleted.tiers).toBe(1);
    expect(result.rows_deleted.company_tier_mappings).toBe(1);
    expect(result.rows_deleted.webhook_log).toBe(1);
    expect(result.rows_deleted.shops).toBe(1);
    expect(result.r2_objects_deleted).toBe(2);
    // tier:7:<hash101> and tier:7:<hash202> both live under the shop prefix.
    expect(result.kv_keys_deleted).toBe(2);
  });

  it('leaves the bystander shop completely intact', async () => {
    await redactShop(h.env, 7);
    expect(h.tables.shops.map(s => s.id)).toEqual([99]);
    expect(h.tables.applications.map(a => a.id)).toEqual([3]);
    expect(h.tables.assets.map(a => a.id)).toEqual([20]);
    expect(h.tables.asset_visibility_rules.map(v => v.asset_id)).toEqual([20]);
    expect(h.tables.tiers.map(t => t.id)).toEqual([2]);
    expect(h.r2Keys()).toEqual(['shops/99/applications/3/other.pdf']);
    const targetHash = await hashIdAsync('101');
    expect(h.kvKeys()[`tier:99:${targetHash}`]).toBe('{"b2b":true}');
    expect(h.kvKeys()['unrelated:key']).toBe('leave-me');
  });

  it('removes both shop-cache KV keys for the target shop', async () => {
    // Seed an extra KV row so we know the prefix delete walks the whole list.
    const otherHash = await hashIdAsync('202');
    expect(Object.keys((await seedHarness()).kvKeys())).toContain(`tier:7:${otherHash}`);
    const fresh = await seedHarness();
    const result = await redactShop(fresh.env, 7);
    expect(result.kv_keys_deleted).toBe(2);
  });
});
