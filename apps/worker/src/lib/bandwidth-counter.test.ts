import { describe, it, expect, beforeEach } from 'vitest';
import {
  assertWithinBudget,
  getCapBytes,
  getMonthlyUsage,
  monthKey,
  recordDownload,
} from './bandwidth-counter.js';

function fakeKv(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv: KVNamespace = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<KVNamespaceListResult<unknown, string>> {
      return { keys: [], list_complete: true, cacheStatus: null };
    },
    async getWithMetadata(): Promise<KVNamespaceGetWithMetadataResult<string, unknown>> {
      return { value: null, metadata: null, cacheStatus: null };
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

describe('bandwidth-counter', () => {
  let kv: KVNamespace;
  beforeEach(() => {
    ({ kv } = fakeKv());
  });

  it('monthKey is stable for a given UTC month', () => {
    const may = new Date(Date.UTC(2026, 4, 15));
    expect(monthKey(7, may)).toBe('bw:7:2026-05');
  });

  it('getMonthlyUsage returns 0 when the bucket is empty', async () => {
    expect(await getMonthlyUsage(kv, 7)).toBe(0);
  });

  it('recordDownload + getMonthlyUsage accumulates bytes', async () => {
    await recordDownload(kv, 7, 100);
    await recordDownload(kv, 7, 50);
    expect(await getMonthlyUsage(kv, 7)).toBe(150);
  });

  it('recordDownload ignores zero / negative / NaN', async () => {
    await recordDownload(kv, 7, 0);
    await recordDownload(kv, 7, -10);
    await recordDownload(kv, 7, NaN);
    expect(await getMonthlyUsage(kv, 7)).toBe(0);
  });

  it('assertWithinBudget returns true below the cap', async () => {
    const r = await assertWithinBudget(kv, 7);
    expect(r.withinBudget).toBe(true);
    expect(r.capBytes).toBe(getCapBytes());
  });

  it('assertWithinBudget returns false when the bucket is at the cap', async () => {
    await recordDownload(kv, 7, getCapBytes());
    const r = await assertWithinBudget(kv, 7);
    expect(r.withinBudget).toBe(false);
  });

  it('separate shops have separate buckets', async () => {
    await recordDownload(kv, 7, 100);
    await recordDownload(kv, 8, 9999);
    expect(await getMonthlyUsage(kv, 7)).toBe(100);
    expect(await getMonthlyUsage(kv, 8)).toBe(9999);
  });

  it('different months bucket independently', async () => {
    const may = new Date(Date.UTC(2026, 4, 15));
    const june = new Date(Date.UTC(2026, 5, 1));
    await recordDownload(kv, 7, 100, may);
    await recordDownload(kv, 7, 200, june);
    expect(await getMonthlyUsage(kv, 7, may)).toBe(100);
    expect(await getMonthlyUsage(kv, 7, june)).toBe(200);
  });
});
