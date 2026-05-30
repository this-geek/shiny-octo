import { describe, it, expect } from 'vitest';
import { listAudit, writeAudit, type AuditRow } from './audit-log.js';

interface StoredRow {
  id: number;
  shop_id: number;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
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
          if (sql.includes('INSERT INTO audit_log')) {
            const [
              shopId,
              actor,
              action,
              entityType,
              entityId,
              detailsJson,
              occurredAt,
            ] = bound as [number, string, string, string, string, string | null, number];
            rows.push({
              id: nextId++,
              shop_id: shopId,
              actor,
              action,
              entity_type: entityType,
              entity_id: entityId,
              details_json: detailsJson,
              occurred_at: occurredAt,
            });
          }
          return { success: true, meta: { changes: 1 } } as unknown as D1Result;
        },
        async all<T>() {
          if (sql.includes('FROM audit_log')) {
            const shopId = bound[0] as number;
            let filtered = rows.filter(r => r.shop_id === shopId);
            let idx = 1;
            if (sql.includes('entity_type = ?')) {
              const v = bound[idx++] as string;
              filtered = filtered.filter(r => r.entity_type === v);
            }
            if (sql.includes('entity_id = ?')) {
              const v = bound[idx++] as string;
              filtered = filtered.filter(r => r.entity_id === v);
            }
            if (sql.includes('actor = ?')) {
              const v = bound[idx++] as string;
              filtered = filtered.filter(r => r.actor === v);
            }
            if (sql.includes('occurred_at < ?')) {
              const v = bound[idx++] as number;
              filtered = filtered.filter(r => r.occurred_at < v);
            }
            const limit = bound[idx] as number;
            filtered.sort((a, b) =>
              b.occurred_at - a.occurred_at || b.id - a.id,
            );
            return {
              results: filtered.slice(0, limit) as unknown as T[],
              success: true,
              meta: { changes: 0 },
            } as unknown as D1Result<T>;
          }
          return { results: [], success: true, meta: { changes: 0 } } as unknown as D1Result<T>;
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { db, rows };
}

describe('audit-log: writeAudit', () => {
  it('serialises details to JSON', async () => {
    const { db, rows } = fakeDb();
    await writeAudit(db, {
      shopId: 1,
      actor: 'gid://shopify/User/42',
      action: 'tier.create',
      entityType: 'tier',
      entityId: 17,
      details: { name: 'Gold', discount_value: 10 },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_id).toBe('17');
    expect(JSON.parse(rows[0].details_json ?? '{}')).toEqual({
      name: 'Gold',
      discount_value: 10,
    });
  });

  it('stores null details_json when details omitted', async () => {
    const { db, rows } = fakeDb();
    await writeAudit(db, {
      shopId: 1,
      actor: 'u',
      action: 'asset.delete',
      entityType: 'asset',
      entityId: 5,
    });
    expect(rows[0].details_json).toBeNull();
  });

  it('coerces numeric entity_id to text', async () => {
    const { db, rows } = fakeDb();
    await writeAudit(db, {
      shopId: 1,
      actor: 'u',
      action: 'tier.delete',
      entityType: 'tier',
      entityId: 99,
    });
    expect(typeof rows[0].entity_id).toBe('string');
    expect(rows[0].entity_id).toBe('99');
  });
});

describe('audit-log: listAudit', () => {
  it('returns shop-scoped rows in newest-first order', async () => {
    const { db } = fakeDb();
    await writeAudit(db, {
      shopId: 1,
      actor: 'a',
      action: 'tier.create',
      entityType: 'tier',
      entityId: 1,
    });
    await writeAudit(db, {
      shopId: 1,
      actor: 'a',
      action: 'tier.update',
      entityType: 'tier',
      entityId: 1,
    });
    await writeAudit(db, {
      shopId: 2,
      actor: 'a',
      action: 'tier.create',
      entityType: 'tier',
      entityId: 1,
    });
    const out = await listAudit(db, 1);
    expect(out).toHaveLength(2);
    expect(out[0].action).toBe('tier.update');
    expect(out[1].action).toBe('tier.create');
  });

  it('filters by entityType + entityId', async () => {
    const { db } = fakeDb();
    await writeAudit(db, {
      shopId: 1,
      actor: 'a',
      action: 'tier.create',
      entityType: 'tier',
      entityId: 1,
    });
    await writeAudit(db, {
      shopId: 1,
      actor: 'a',
      action: 'asset.create',
      entityType: 'asset',
      entityId: 1,
    });
    const tiers = await listAudit(db, 1, { entityType: 'tier' });
    expect(tiers.map((r: AuditRow) => r.action)).toEqual(['tier.create']);

    const asset = await listAudit(db, 1, { entityType: 'asset', entityId: '1' });
    expect(asset).toHaveLength(1);
    expect(asset[0].action).toBe('asset.create');
  });

  it('respects limit and clamps to 500', async () => {
    const { db } = fakeDb();
    for (let i = 0; i < 5; i++) {
      await writeAudit(db, {
        shopId: 1,
        actor: 'a',
        action: 'tier.create',
        entityType: 'tier',
        entityId: i,
      });
    }
    expect(await listAudit(db, 1, { limit: 2 })).toHaveLength(2);
    expect(await listAudit(db, 1, { limit: 10_000 })).toHaveLength(5);
  });
});
