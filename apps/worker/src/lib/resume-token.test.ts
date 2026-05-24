import { describe, it, expect } from 'vitest';
import {
  ResumeTokenError,
  signResumeToken,
  verifyResumeToken,
} from './resume-token.js';

const MASTER_KEY = '00'.repeat(32);
const SHOP = 'demo.myshopify.com';
const OTHER_SHOP = 'other.myshopify.com';

describe('resume-token', () => {
  it('round-trips a signed token', async () => {
    const token = await signResumeToken(123, 'buyer@example.com', SHOP, MASTER_KEY);
    const payload = await verifyResumeToken(token, SHOP, MASTER_KEY);
    expect(payload.aid).toBe(123);
    expect(payload.email).toBe('buyer@example.com');
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('lowercases the email so case mismatches do not break resume', async () => {
    const token = await signResumeToken(1, 'Buyer@Example.com', SHOP, MASTER_KEY);
    const p = await verifyResumeToken(token, SHOP, MASTER_KEY);
    expect(p.email).toBe('buyer@example.com');
  });

  it('rejects tokens minted by a different shop', async () => {
    const token = await signResumeToken(1, 'a@b.com', SHOP, MASTER_KEY);
    await expect(verifyResumeToken(token, OTHER_SHOP, MASTER_KEY)).rejects.toThrow(
      ResumeTokenError,
    );
  });

  it('rejects expired tokens', async () => {
    const past = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30; // 30d ago
    const token = await signResumeToken(1, 'a@b.com', SHOP, MASTER_KEY, past);
    await expect(verifyResumeToken(token, SHOP, MASTER_KEY)).rejects.toThrow(
      /expired/,
    );
  });

  it('rejects a tampered payload', async () => {
    const token = await signResumeToken(1, 'a@b.com', SHOP, MASTER_KEY);
    const [, sig] = token.split('.');
    const fakePayload = btoa(JSON.stringify({ aid: 999, email: 'evil@x.com', exp: 2_000_000_000 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const tampered = `${fakePayload}.${sig}`;
    await expect(verifyResumeToken(tampered, SHOP, MASTER_KEY)).rejects.toThrow(
      /signature/,
    );
  });

  it('rejects malformed tokens', async () => {
    await expect(verifyResumeToken('not.a.token.at.all', SHOP, MASTER_KEY)).rejects.toThrow(
      ResumeTokenError,
    );
    await expect(verifyResumeToken('no-dot-here', SHOP, MASTER_KEY)).rejects.toThrow();
    await expect(verifyResumeToken('foo.notHex', SHOP, MASTER_KEY)).rejects.toThrow();
  });

  it('sets exp roughly 14 days out', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signResumeToken(1, 'a@b.com', SHOP, MASTER_KEY, now);
    const p = await verifyResumeToken(token, SHOP, MASTER_KEY, now);
    const ttl = p.exp - now;
    expect(ttl).toBe(14 * 24 * 60 * 60);
  });
});
