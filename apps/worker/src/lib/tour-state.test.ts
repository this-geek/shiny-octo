import { describe, it, expect, beforeEach } from 'vitest';
import { dismissTour, hasDismissedTour } from './tour-state.js';

function fakeKv(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

describe('tour-state', () => {
  let kv: KVNamespace;
  let store: Map<string, string>;
  beforeEach(() => {
    ({ kv, store } = fakeKv());
  });

  it('returns false before dismissal', async () => {
    expect(await hasDismissedTour(kv, 7, 'gid://shopify/Customer/1')).toBe(false);
  });

  it('flips to true after dismissTour', async () => {
    await dismissTour(kv, 7, 'gid://shopify/Customer/1', 1000);
    expect(await hasDismissedTour(kv, 7, 'gid://shopify/Customer/1')).toBe(true);
  });

  it('is keyed per shop + per customer (no cross-tenant leak)', async () => {
    await dismissTour(kv, 7, 'gid://shopify/Customer/1', 1000);
    expect(await hasDismissedTour(kv, 8, 'gid://shopify/Customer/1')).toBe(false);
    expect(await hasDismissedTour(kv, 7, 'gid://shopify/Customer/2')).toBe(false);
  });

  it('hashes the customer id rather than storing the raw GID', async () => {
    await dismissTour(kv, 7, 'gid://shopify/Customer/42', 1000);
    const keys = Array.from(store.keys());
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^tour:7:[0-9a-f]+$/);
    expect(keys[0]).not.toContain('Customer/42');
  });
});
