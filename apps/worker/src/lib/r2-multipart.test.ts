import { describe, it, expect } from 'vitest';
import { newSessionId, sessionKvKey } from './r2-multipart.js';

describe('r2-multipart helpers', () => {
  it('sessionKvKey is shop-scoped', () => {
    expect(sessionKvKey(7, 'abc')).toBe('upload:7:abc');
  });

  it('newSessionId returns a 32-char hex string', () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('newSessionId returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newSessionId()));
    expect(ids.size).toBe(100);
  });
});
