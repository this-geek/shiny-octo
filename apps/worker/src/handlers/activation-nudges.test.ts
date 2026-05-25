import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { runActivationNudgesScan } from './activation-nudges.js';
import { encrypt } from '../lib/crypto.js';
import type { Env } from '../types.js';

const SHOP = 'demo.myshopify.com';
const SHOP_ID = 7;
const MASTER_KEY = '00'.repeat(32);

interface AppFixture {
  id: number;
  decided_at: number;
  shopify_customer_id: string | null;
}

async function makeEnv(apps: AppFixture[]): Promise<{
  env: Env;
  queue: Array<{ topic: string; body: string }>;
  nudges: Array<{ application_id: number; kind: string; sent_at: number }>;
}> {
  const queue: Array<{ topic: string; body: string }> = [];
  const nudges: Array<{ application_id: number; kind: string; sent_at: number }> = [];
  const encryptedToken = await encrypt('shpat_FAKE', SHOP, MASTER_KEY);

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM application_nudges')) {
            const [appId, kind] = bound as [number, string];
            const hit = nudges.find(r => r.application_id === appId && r.kind === kind);
            return hit ? ({ x: 1 } as unknown as T) : null;
          }
          return null;
        },
        async all<T>(): Promise<D1Result<T>> {
          if (sql.includes('FROM shops')) {
            return {
              results: [
                {
                  id: SHOP_ID,
                  shopify_domain: SHOP,
                  access_token_encrypted: encryptedToken,
                },
              ] as unknown as T[],
              success: true,
              meta: {},
            } as unknown as D1Result<T>;
          }
          if (sql.includes('FROM applications')) {
            const [shopId, lookBackTs, lookForwardTs] = bound as [number, number, number];
            const rows = apps
              .filter(
                a =>
                  shopId === SHOP_ID &&
                  a.decided_at >= lookBackTs &&
                  a.decided_at <= lookForwardTs,
              )
              .map(a => ({
                id: a.id,
                decided_at: a.decided_at,
                shopify_customer_id: a.shopify_customer_id,
              }));
            return { results: rows as unknown as T[], success: true, meta: {} } as unknown as D1Result<T>;
          }
          return { results: [], success: true, meta: {} } as unknown as D1Result<T>;
        },
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO application_nudges')) {
            const [appId, kind, sentAt] = bound as [number, string, number];
            if (!nudges.some(n => n.application_id === appId && n.kind === kind)) {
              nudges.push({ application_id: appId, kind, sent_at: sentAt });
            }
          }
          return { success: true, meta: { changes: 1 } } as unknown as D1Result;
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;

  const queueBinding = {
    send: async (msg: unknown) => {
      queue.push(msg as { topic: string; body: string });
    },
  } as unknown as Queue;

  const env: Env = {
    DB: db,
    KV_SESSIONS: {} as KVNamespace,
    KV_IDEMPOTENCY: {} as KVNamespace,
    KV_HOT_CACHE: {} as KVNamespace,
    ASSETS_BUCKET: {} as R2Bucket,
    WEBHOOK_QUEUE: queueBinding,
    SHOPIFY_API_KEY: 'k',
    SHOPIFY_API_SECRET: 's',
    MASTER_KEY,
    RESEND_API_KEY: 'r',
    APP_URL: 'https://app',
    SHOPIFY_API_VERSION: '2026-04',
    ADMIN_ORIGIN: 'https://admin',
    EMAIL_FROM: 'B2B <hello@demo.com>',
  };
  return { env, queue, nudges };
}

const NOW = 1_700_000_000;

describe('activation-nudges', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ data: { orders: { edges: [] } } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('enqueues a 14-day nudge for an approved buyer with no orders', async () => {
    const { env, queue, nudges } = await makeEnv([
      { id: 100, decided_at: NOW - 14 * 86400, shopify_customer_id: 'gid://shopify/Customer/1' },
    ]);
    const result = await runActivationNudgesScan(env, NOW);
    expect(result.scanned).toBe(1);
    expect(result.sent).toBe(1);
    expect(queue).toHaveLength(1);
    expect(queue[0].topic).toBe('_internal/send-application-email');
    const payload = JSON.parse(queue[0].body) as { application_id: number; kind: string };
    expect(payload.application_id).toBe(100);
    expect(payload.kind).toBe('nudge_14d');
    expect(nudges).toEqual([{ application_id: 100, kind: 'nudge_14d', sent_at: NOW }]);
  });

  it('skips a buyer who already received that nudge', async () => {
    const { env, queue, nudges } = await makeEnv([
      { id: 100, decided_at: NOW - 14 * 86400, shopify_customer_id: 'gid://shopify/Customer/1' },
    ]);
    nudges.push({ application_id: 100, kind: 'nudge_14d', sent_at: NOW - 86400 });
    const result = await runActivationNudgesScan(env, NOW);
    expect(result.sent).toBe(0);
    expect(queue).toHaveLength(0);
  });

  it('skips a buyer who has placed an order since approval', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { orders: { edges: [{ node: { id: 'gid://shopify/Order/9' } }] } } }),
        { status: 200 },
      ),
    );
    const { env, queue, nudges } = await makeEnv([
      { id: 100, decided_at: NOW - 14 * 86400, shopify_customer_id: 'gid://shopify/Customer/1' },
    ]);
    const result = await runActivationNudgesScan(env, NOW);
    expect(result.sent).toBe(0);
    expect(queue).toHaveLength(0);
    expect(nudges).toHaveLength(0);
  });

  it('does not fire a nudge for a buyer who is between milestones', async () => {
    const { env, queue } = await makeEnv([
      { id: 100, decided_at: NOW - 20 * 86400, shopify_customer_id: 'gid://shopify/Customer/1' },
    ]);
    await runActivationNudgesScan(env, NOW);
    expect(queue).toHaveLength(0);
  });

  it('fires 30-day nudge after the 14-day was already sent', async () => {
    const { env, queue, nudges } = await makeEnv([
      { id: 100, decided_at: NOW - 30 * 86400, shopify_customer_id: 'gid://shopify/Customer/1' },
    ]);
    nudges.push({ application_id: 100, kind: 'nudge_14d', sent_at: NOW - 16 * 86400 });
    const result = await runActivationNudgesScan(env, NOW);
    expect(result.sent).toBe(1);
    expect(queue).toHaveLength(1);
    expect(JSON.parse(queue[0].body).kind).toBe('nudge_30d');
  });

  it('still enqueues when shopify_customer_id is null (no probe possible)', async () => {
    const { env, queue } = await makeEnv([
      { id: 100, decided_at: NOW - 14 * 86400, shopify_customer_id: null },
    ]);
    await runActivationNudgesScan(env, NOW);
    expect(queue).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
