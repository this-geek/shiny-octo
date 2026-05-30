import { describe, it, expect } from 'vitest';
import { listOpsLog, writeOpsLog } from './ops-log.js';

interface StoredRow {
  id: number;
  shop_id: number | null;
  operator_email: string;
  action: string;
  details_json: string | null;
  occurred_at: number;
}

function fakeDb(): { db: D1Database; rows: StoredRow[] } {
  const rows: StoredRow[] = [];
  let nextId = 1;
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async run() {
          if (sql.includes('INSERT INTO ops_log')) {
            const [shopId, email, action, detailsJson, occurredAt] = bound as [
              number | null,
              string,
              string,
              string | null,
              number,
            ];
            rows.push({
              id: nextId++,
              shop_id: shopId,
              operator_email: email,
              action,
              details_json: detailsJson,
              occurred_at: occurredAt,
            });
          }
          return { success: true, meta: { changes: 1 } } as unknown as D1Result;
        },
        async all<T>() {
          if (sql.includes('FROM ops_log')) {
            let filtered = [...rows];
            let idx = 0;
            if (sql.includes('shop_id = ?')) {
              const v = bound[idx++] as number;
              filtered = filtered.filter(r => r.shop_id === v);
            }
            if (sql.includes('operator_email = ?')) {
              const v = bound[idx++] as string;
              filtered = filtered.filter(r => r.operator_email === v);
            }
            if (sql.includes('occurred_at < ?')) {
              const v = bound[idx++] as number;
              filtered = filtered.filter(r => r.occurred_at < v);
            }
            const limit = bound[idx] as number;
            filtered.sort((a, b) => b.occurred_at - a.occurred_at || b.id - a.id);
            return {
              results: filtered.slice(0, limit) as unknown as T[],
              success: true,
              meta: { changes: 0 },
            } as unknown as D1Result<T>;
          }
          return { results: [], success: true, meta: {} } as unknown as D1Result<T>;
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { db, rows };
}

describe('ops-log: writeOpsLog', () => {
  it('serialises details JSON and accepts null shop_id', async () => {
    const { db, rows } = fakeDb();
    await writeOpsLog(db, {
      shopId: null,
      operatorEmail: 'op@example.com',
      action: 'shops.list',
    });
    await writeOpsLog(db, {
      shopId: 7,
      operatorEmail: 'op@example.com',
      action: 'feature_flags.update',
      details: { before: {}, after: { quick_order: true } },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].shop_id).toBeNull();
    expect(rows[0].details_json).toBeNull();
    expect(JSON.parse(rows[1].details_json ?? '{}')).toEqual({
      before: {},
      after: { quick_order: true },
    });
  });
});

describe('ops-log: listOpsLog', () => {
  it('filters by shop and operator, newest-first', async () => {
    const { db } = fakeDb();
    await writeOpsLog(db, { shopId: 1, operatorEmail: 'a', action: 'x' });
    await writeOpsLog(db, { shopId: 2, operatorEmail: 'a', action: 'y' });
    await writeOpsLog(db, { shopId: 1, operatorEmail: 'b', action: 'z' });

    expect((await listOpsLog(db, { shopId: 1 })).map(r => r.action)).toEqual(['z', 'x']);
    expect((await listOpsLog(db, { operatorEmail: 'a' })).map(r => r.action)).toEqual([
      'y',
      'x',
    ]);
  });
});
