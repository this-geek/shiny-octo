import { describe, it, expect } from 'vitest';
import {
  NUDGE_KINDS,
  daysBetween,
  hasNudgeBeenSent,
  nudgeKindForDaysSinceApproval,
  recordNudgeSent,
} from './nudge-store.js';

function fakeDb(): { db: D1Database; rows: Array<{ application_id: number; kind: string; sent_at: number }> } {
  const rows: Array<{ application_id: number; kind: string; sent_at: number }> = [];
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
            const hit = rows.find(r => r.application_id === appId && r.kind === kind);
            return hit ? ({ x: 1 } as unknown as T) : null;
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO application_nudges')) {
            const [appId, kind, sentAt] = bound as [number, string, number];
            const exists = rows.some(r => r.application_id === appId && r.kind === kind);
            if (!exists) rows.push({ application_id: appId, kind, sent_at: sentAt });
          }
          return { success: true, meta: { changes: 1 } } as unknown as D1Result;
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { db, rows };
}

describe('nudge-store', () => {
  it('exposes the three nudge kinds in order', () => {
    expect(NUDGE_KINDS).toEqual(['nudge_14d', 'nudge_30d', 'nudge_60d']);
  });

  it('nudgeKindForDaysSinceApproval returns the right milestone within slack', () => {
    expect(nudgeKindForDaysSinceApproval(13)).toBe(null);
    expect(nudgeKindForDaysSinceApproval(14)).toBe('nudge_14d');
    expect(nudgeKindForDaysSinceApproval(15)).toBe('nudge_14d');
    expect(nudgeKindForDaysSinceApproval(16)).toBe(null);
    expect(nudgeKindForDaysSinceApproval(30)).toBe('nudge_30d');
    expect(nudgeKindForDaysSinceApproval(60)).toBe('nudge_60d');
    expect(nudgeKindForDaysSinceApproval(120)).toBe(null);
  });

  it('daysBetween floors the diff and clamps negatives to 0', () => {
    expect(daysBetween(0, 86400)).toBe(1);
    expect(daysBetween(0, 86400 + 3600)).toBe(1);
    expect(daysBetween(0, 86400 * 14)).toBe(14);
    expect(daysBetween(1000, 500)).toBe(0);
  });

  it('records and reads back a nudge', async () => {
    const { db, rows } = fakeDb();
    expect(await hasNudgeBeenSent(db, 42, 'nudge_14d')).toBe(false);
    await recordNudgeSent(db, 42, 'nudge_14d', 1000);
    expect(rows).toHaveLength(1);
    expect(await hasNudgeBeenSent(db, 42, 'nudge_14d')).toBe(true);
    // different kind still false
    expect(await hasNudgeBeenSent(db, 42, 'nudge_30d')).toBe(false);
    // different application still false
    expect(await hasNudgeBeenSent(db, 7, 'nudge_14d')).toBe(false);
  });

  it('recordNudgeSent is idempotent', async () => {
    const { db, rows } = fakeDb();
    await recordNudgeSent(db, 42, 'nudge_14d', 1000);
    await recordNudgeSent(db, 42, 'nudge_14d', 2000);
    expect(rows).toHaveLength(1);
    expect(rows[0].sent_at).toBe(1000);
  });
});
