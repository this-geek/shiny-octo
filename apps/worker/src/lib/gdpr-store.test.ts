import { describe, it, expect } from 'vitest';
import {
  APP_UNINSTALL_PURGE_GRACE_S,
  CUSTOMER_REDACT_GRACE_S,
  DATA_REQUEST_GRACE_S,
  SHOP_REDACT_GRACE_S,
  cancelIfPending,
  claimForProcessing,
  dueAtFor,
  expediteIfPending,
  getGdprRequest,
  insertGdprRequest,
  listDue,
  listPendingForShop,
  markCompleted,
  markFailed,
  type GdprRequestRow,
} from './gdpr-store.js';

interface InMemoryRow extends GdprRequestRow {}

function fakeDb(): { db: D1Database; rows: InMemoryRow[] } {
  const rows: InMemoryRow[] = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('SELECT * FROM gdpr_requests WHERE id = ?')) {
            const [id] = bound as [string];
            const hit = rows.find(r => r.id === id);
            return (hit as unknown as T) ?? null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("status = 'pending'\n       ORDER BY due_at ASC")) {
            const [shopId] = bound as [number];
            const out = rows
              .filter(r => r.shop_id === shopId && r.status === 'pending')
              .sort((a, b) => a.due_at - b.due_at);
            return { results: out as unknown as T[] };
          }
          if (sql.includes("status = 'pending' AND due_at <= ?")) {
            const [now, limit] = bound as [number, number];
            const out = rows
              .filter(r => r.status === 'pending' && r.due_at <= now)
              .sort((a, b) => a.due_at - b.due_at)
              .slice(0, limit);
            return { results: out as unknown as T[] };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO gdpr_requests')) {
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
              GdprRequestRow['kind'],
              string | null,
              string,
              number,
              number,
            ];
            if (rows.some(r => r.id === id)) {
              return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            rows.push({
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
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (sql.includes("status = 'processing'")) {
            const [id] = bound as [string];
            const row = rows.find(r => r.id === id);
            if (!row || row.status !== 'pending') {
              return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            row.status = 'processing';
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (sql.includes("status = 'completed'")) {
            const [completedAt, id] = bound as [number, string];
            const row = rows.find(r => r.id === id);
            if (!row) return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            row.status = 'completed';
            row.completed_at = completedAt;
            row.last_error = null;
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (sql.includes("status = 'failed'")) {
            const [err, id] = bound as [string, string];
            const row = rows.find(r => r.id === id);
            if (!row) return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            row.status = 'failed';
            row.last_error = err;
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (sql.includes("status = 'cancelled'")) {
            const [id, shopId, now] = bound as [string, number, number];
            const row = rows.find(r => r.id === id);
            if (
              !row ||
              row.shop_id !== shopId ||
              row.status !== 'pending' ||
              row.due_at <= now
            ) {
              return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            row.status = 'cancelled';
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (sql.includes('SET due_at = ?')) {
            const [newDue, id, shopId] = bound as [number, string, number];
            const row = rows.find(r => r.id === id);
            if (!row || row.shop_id !== shopId || row.status !== 'pending') {
              return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            row.due_at = newDue;
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          return { success: true, meta: { changes: 0 } } as unknown as D1Result;
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { db, rows };
}

const NOW = 1_700_000_000;

const seedInput = (overrides: Partial<Parameters<typeof insertGdprRequest>[1]> = {}) => ({
  id: 'wh-1',
  shop_id: 7,
  shop_domain: 'acme.myshopify.com',
  kind: 'customer_redact' as const,
  shopify_customer_id: '101',
  payload_json: '{"customer":{"id":101}}',
  received_at: NOW,
  due_at: NOW + CUSTOMER_REDACT_GRACE_S,
  ...overrides,
});

describe('dueAtFor', () => {
  it('matches the per-kind grace constants', () => {
    expect(dueAtFor('customer_data_request', NOW)).toBe(NOW + DATA_REQUEST_GRACE_S);
    expect(dueAtFor('customer_redact', NOW)).toBe(NOW + CUSTOMER_REDACT_GRACE_S);
    expect(dueAtFor('shop_redact', NOW)).toBe(NOW + SHOP_REDACT_GRACE_S);
    expect(dueAtFor('app_uninstall_purge', NOW)).toBe(NOW + APP_UNINSTALL_PURGE_GRACE_S);
  });

  it('stand-down is the user-confirmed 7 days for redact kinds', () => {
    expect(CUSTOMER_REDACT_GRACE_S).toBe(7 * 86400);
    expect(SHOP_REDACT_GRACE_S).toBe(7 * 86400);
  });
});

describe('insertGdprRequest', () => {
  it('inserts a pending row', async () => {
    const { db, rows } = fakeDb();
    await insertGdprRequest(db, seedInput());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].kind).toBe('customer_redact');
  });

  it('is idempotent on id collision (replay of the same webhook)', async () => {
    const { db, rows } = fakeDb();
    await insertGdprRequest(db, seedInput());
    await insertGdprRequest(db, seedInput({ payload_json: '{"different":true}' }));
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_json).toBe('{"customer":{"id":101}}');
  });
});

describe('listPendingForShop / listDue', () => {
  it('listPendingForShop returns only pending rows for that shop in due-asc order', async () => {
    const { db } = fakeDb();
    await insertGdprRequest(db, seedInput({ id: 'a', due_at: NOW + 100 }));
    await insertGdprRequest(db, seedInput({ id: 'b', due_at: NOW + 50 }));
    await insertGdprRequest(db, seedInput({ id: 'c', shop_id: 99, due_at: NOW + 10 }));
    const pending = await listPendingForShop(db, 7);
    expect(pending.map(r => r.id)).toEqual(['b', 'a']);
  });

  it('listDue excludes rows whose due_at is in the future', async () => {
    const { db } = fakeDb();
    await insertGdprRequest(db, seedInput({ id: 'past', due_at: NOW - 1 }));
    await insertGdprRequest(db, seedInput({ id: 'now', due_at: NOW }));
    await insertGdprRequest(db, seedInput({ id: 'future', due_at: NOW + 1 }));
    const due = await listDue(db, NOW, 10);
    expect(due.map(r => r.id)).toEqual(['past', 'now']);
  });
});

describe('claimForProcessing', () => {
  it('flips pending → processing exactly once', async () => {
    const { db } = fakeDb();
    await insertGdprRequest(db, seedInput());
    expect(await claimForProcessing(db, 'wh-1')).toBe(true);
    expect(await claimForProcessing(db, 'wh-1')).toBe(false);
    const row = await getGdprRequest(db, 'wh-1');
    expect(row?.status).toBe('processing');
  });
});

describe('markCompleted / markFailed', () => {
  it('markCompleted writes the timestamp and clears last_error', async () => {
    const { db } = fakeDb();
    await insertGdprRequest(db, seedInput());
    await claimForProcessing(db, 'wh-1');
    await markCompleted(db, 'wh-1', NOW + 60);
    const row = await getGdprRequest(db, 'wh-1');
    expect(row?.status).toBe('completed');
    expect(row?.completed_at).toBe(NOW + 60);
  });

  it('markFailed records the error', async () => {
    const { db } = fakeDb();
    await insertGdprRequest(db, seedInput());
    await markFailed(db, 'wh-1', 'r2 list timed out');
    const row = await getGdprRequest(db, 'wh-1');
    expect(row?.status).toBe('failed');
    expect(row?.last_error).toBe('r2 list timed out');
  });
});

describe('cancelIfPending / expediteIfPending', () => {
  it('cancel works during the stand-down', async () => {
    const { db } = fakeDb();
    await insertGdprRequest(db, seedInput());
    expect(await cancelIfPending(db, 7, 'wh-1', NOW)).toBe(true);
    const row = await getGdprRequest(db, 'wh-1');
    expect(row?.status).toBe('cancelled');
  });

  it('cancel is refused after the stand-down has elapsed', async () => {
    const { db } = fakeDb();
    await insertGdprRequest(db, seedInput({ due_at: NOW + 10 }));
    expect(await cancelIfPending(db, 7, 'wh-1', NOW + 20)).toBe(false);
    const row = await getGdprRequest(db, 'wh-1');
    expect(row?.status).toBe('pending');
  });

  it('cancel is refused for a different shop (cross-tenant safety)', async () => {
    const { db } = fakeDb();
    await insertGdprRequest(db, seedInput());
    expect(await cancelIfPending(db, 999, 'wh-1', NOW)).toBe(false);
    const row = await getGdprRequest(db, 'wh-1');
    expect(row?.status).toBe('pending');
  });

  it('expedite pulls due_at to now so the next sweep grabs it', async () => {
    const { db } = fakeDb();
    await insertGdprRequest(db, seedInput({ due_at: NOW + 100_000 }));
    expect(await expediteIfPending(db, 7, 'wh-1', NOW)).toBe(true);
    const row = await getGdprRequest(db, 'wh-1');
    expect(row?.due_at).toBe(NOW);
    expect(row?.status).toBe('pending');
  });

  it('expedite is refused for a different shop', async () => {
    const { db } = fakeDb();
    await insertGdprRequest(db, seedInput({ due_at: NOW + 1000 }));
    expect(await expediteIfPending(db, 999, 'wh-1', NOW)).toBe(false);
  });
});
