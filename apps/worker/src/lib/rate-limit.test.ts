import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, windowKey } from './rate-limit.js';

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

describe('rate-limit: windowKey', () => {
  it('buckets by UTC minute', () => {
    const t = new Date(Date.UTC(2026, 4, 30, 12, 34, 0));
    const minute = Math.floor(t.getTime() / 60_000);
    expect(windowKey('admin', 'shop.myshopify.com', t)).toBe(
      `rl:admin:shop.myshopify.com:${minute}`,
    );
  });

  it('rolls to a new bucket on the minute boundary', () => {
    const a = new Date(Date.UTC(2026, 4, 30, 12, 34, 59, 999));
    const b = new Date(Date.UTC(2026, 4, 30, 12, 35, 0, 0));
    expect(windowKey('admin', 'x', a)).not.toBe(windowKey('admin', 'x', b));
  });
});

describe('rate-limit: checkRateLimit', () => {
  let kv: KVNamespace;
  beforeEach(() => {
    ({ kv } = fakeKv());
  });

  it('allows the first request and increments the counter', async () => {
    const r = await checkRateLimit(kv, 'admin', 'shop.myshopify.com', 100);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
    expect(r.limit).toBe(100);
    expect(r.retryAfterSeconds).toBe(0);
  });

  it('allows requests up to and including the limit, denies beyond', async () => {
    const t = new Date(Date.UTC(2026, 4, 30, 12, 0, 0));
    for (let i = 1; i <= 3; i++) {
      const r = await checkRateLimit(kv, 'public', '1.2.3.4', 3, t);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i);
    }
    const denied = await checkRateLimit(kv, 'public', '1.2.3.4', 3, t);
    expect(denied.allowed).toBe(false);
    expect(denied.count).toBe(3);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('denied requests do NOT consume capacity from the window', async () => {
    const t = new Date(Date.UTC(2026, 4, 30, 12, 0, 0));
    await checkRateLimit(kv, 'public', '1.2.3.4', 1, t);
    await checkRateLimit(kv, 'public', '1.2.3.4', 1, t); // denied
    await checkRateLimit(kv, 'public', '1.2.3.4', 1, t); // still denied
    // Roll to next minute — limit should reset.
    const next = new Date(t.getTime() + 60_000);
    const r = await checkRateLimit(kv, 'public', '1.2.3.4', 1, next);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
  });

  it('separate ids in the same bucket are independent', async () => {
    const t = new Date(Date.UTC(2026, 4, 30, 12, 0, 0));
    await checkRateLimit(kv, 'public', '1.2.3.4', 1, t);
    const r = await checkRateLimit(kv, 'public', '5.6.7.8', 1, t);
    expect(r.allowed).toBe(true);
  });

  it('separate buckets for the same id are independent', async () => {
    const t = new Date(Date.UTC(2026, 4, 30, 12, 0, 0));
    await checkRateLimit(kv, 'admin', 'shop.myshopify.com', 1, t);
    const r = await checkRateLimit(kv, 'public', 'shop.myshopify.com', 1, t);
    expect(r.allowed).toBe(true);
  });

  it('window rolls over on the next minute', async () => {
    const t = new Date(Date.UTC(2026, 4, 30, 12, 0, 30));
    await checkRateLimit(kv, 'public', '1.2.3.4', 1, t);
    const denied = await checkRateLimit(kv, 'public', '1.2.3.4', 1, t);
    expect(denied.allowed).toBe(false);
    // Same minute → still denied.
    const t2 = new Date(Date.UTC(2026, 4, 30, 12, 0, 59));
    expect((await checkRateLimit(kv, 'public', '1.2.3.4', 1, t2)).allowed).toBe(false);
    // Next minute → allowed.
    const t3 = new Date(Date.UTC(2026, 4, 30, 12, 1, 0));
    expect((await checkRateLimit(kv, 'public', '1.2.3.4', 1, t3)).allowed).toBe(true);
  });

  it('retryAfterSeconds reports time remaining in the current window', async () => {
    const t = new Date(Date.UTC(2026, 4, 30, 12, 0, 30));
    await checkRateLimit(kv, 'public', '1.2.3.4', 1, t);
    const denied = await checkRateLimit(kv, 'public', '1.2.3.4', 1, t);
    expect(denied.retryAfterSeconds).toBe(30);
  });

  it('limit of 0 denies everything', async () => {
    const r = await checkRateLimit(kv, 'public', '1.2.3.4', 0);
    expect(r.allowed).toBe(false);
  });

  it('survives a corrupted counter value', async () => {
    const t = new Date(Date.UTC(2026, 4, 30, 12, 0, 0));
    const key = windowKey('public', '1.2.3.4', t);
    const { kv: kv2, store } = fakeKv();
    store.set(key, 'not-a-number');
    const r = await checkRateLimit(kv2, 'public', '1.2.3.4', 5, t);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
  });
});
