import { describe, it, expect } from 'vitest';
import { verifyCustomerAccountToken } from './customer-account-token.js';

const API_KEY = 'test-api-key';
const API_SECRET = 'test-api-secret';
const SHOP_DOMAIN = 'demo.myshopify.com';

function b64url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function signHS256(payload: object, secret: string): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `${signingInput}.${sigB64}`;
}

function basePayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://shopify.com/12345',
    dest: `https://${SHOP_DOMAIN}`,
    aud: API_KEY,
    sub: 'gid://shopify/Customer/9999',
    exp: now + 60,
    nbf: now - 60,
    iat: now,
    jti: 'abc',
    ...overrides,
  };
}

describe('verifyCustomerAccountToken', () => {
  it('accepts a valid token and extracts shop + customer', async () => {
    const token = await signHS256(basePayload(), API_SECRET);
    const ctx = await verifyCustomerAccountToken(token, API_KEY, API_SECRET);
    expect(ctx.shop_domain).toBe(SHOP_DOMAIN);
    expect(ctx.customer_id).toBe('gid://shopify/Customer/9999');
  });

  it('rejects a forged signature', async () => {
    const token = await signHS256(basePayload(), 'wrong-secret');
    await expect(verifyCustomerAccountToken(token, API_KEY, API_SECRET)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signHS256(basePayload({ exp: now - 10 }), API_SECRET);
    await expect(verifyCustomerAccountToken(token, API_KEY, API_SECRET)).rejects.toThrow(/expired/);
  });

  it('rejects a wrong audience', async () => {
    const token = await signHS256(basePayload({ aud: 'someone-else' }), API_SECRET);
    await expect(verifyCustomerAccountToken(token, API_KEY, API_SECRET)).rejects.toThrow(/audience/);
  });

  it('rejects a malformed JWT', async () => {
    await expect(verifyCustomerAccountToken('not.a.jwt.really', API_KEY, API_SECRET)).rejects.toThrow();
  });
});
