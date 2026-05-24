import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifyTurnstile } from './turnstile.js';

describe('verifyTurnstile', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    // no-op; per-test fetch stubs
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('skips when no secret is configured', async () => {
    const r = await verifyTurnstile(undefined, 'tok');
    expect(r).toEqual({ ok: true, skipped: true, errorCodes: [] });
  });

  it('fails closed when secret is set but token missing', async () => {
    const r = await verifyTurnstile('secret', null);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.errorCodes).toContain('missing-input-response');
  });

  it('returns ok on success: true from siteverify', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const r = await verifyTurnstile('s', 'token');
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(false);
  });

  it('surfaces siteverify error-codes on failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }),
        { status: 200 },
      ),
    );
    const r = await verifyTurnstile('s', 'token');
    expect(r.ok).toBe(false);
    expect(r.errorCodes).toContain('invalid-input-response');
  });

  it('reports an http error code when siteverify is non-200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    const r = await verifyTurnstile('s', 'token');
    expect(r.ok).toBe(false);
    expect(r.errorCodes[0]).toMatch(/http-/);
  });

  it('handles a non-json response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const r = await verifyTurnstile('s', 'token');
    expect(r.ok).toBe(false);
    expect(r.errorCodes).toContain('bad-json');
  });
});
