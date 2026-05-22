import { describe, it, expect } from 'vitest';
import { verifyWebhookHmac } from './webhook-hmac.js';

const SECRET = 'test-webhook-secret';

async function makeSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

describe('verifyWebhookHmac', () => {
  it('valid signature passes', async () => {
    const body = JSON.stringify({ id: 123, topic: 'orders/create' });
    const sig = await makeSignature(SECRET, body);
    const result = await verifyWebhookHmac(SECRET, new TextEncoder().encode(body).buffer as ArrayBuffer, sig);
    expect(result).toBe(true);
  });

  it('tampered body fails', async () => {
    const body = JSON.stringify({ id: 123 });
    const sig = await makeSignature(SECRET, body);
    const tamperedBody = JSON.stringify({ id: 456 });
    const result = await verifyWebhookHmac(
      SECRET,
      new TextEncoder().encode(tamperedBody).buffer as ArrayBuffer,
      sig,
    );
    expect(result).toBe(false);
  });

  it('wrong secret fails', async () => {
    const body = JSON.stringify({ id: 123 });
    const sig = await makeSignature(SECRET, body);
    const result = await verifyWebhookHmac(
      'wrong-secret',
      new TextEncoder().encode(body).buffer as ArrayBuffer,
      sig,
    );
    expect(result).toBe(false);
  });

  it('empty body with correct signature passes', async () => {
    const body = '';
    const sig = await makeSignature(SECRET, body);
    const result = await verifyWebhookHmac(SECRET, new TextEncoder().encode(body).buffer as ArrayBuffer, sig);
    expect(result).toBe(true);
  });

  it('unicode body with correct signature passes', async () => {
    const body = JSON.stringify({ name: 'こんにちは', domain: 'test.myshopify.com' });
    const sig = await makeSignature(SECRET, body);
    const result = await verifyWebhookHmac(SECRET, new TextEncoder().encode(body).buffer as ArrayBuffer, sig);
    expect(result).toBe(true);
  });

  it('returns false for completely wrong signature string', async () => {
    const body = JSON.stringify({ id: 1 });
    const result = await verifyWebhookHmac(SECRET, new TextEncoder().encode(body).buffer as ArrayBuffer, 'AAAA');
    expect(result).toBe(false);
  });
});

describe('timing-safe comparison behaviour', () => {
  it('same-length strings with one different char fails (not short-circuited)', async () => {
    const body = 'hello';
    const realSig = await makeSignature(SECRET, body);
    // Flip one character in the signature — same length, one char different
    const chars = realSig.split('');
    // Change last character to something different
    chars[chars.length - 1] = chars[chars.length - 1] === 'A' ? 'B' : 'A';
    const badSig = chars.join('');
    expect(badSig.length).toBe(realSig.length);
    const result = await verifyWebhookHmac(SECRET, new TextEncoder().encode(body).buffer as ArrayBuffer, badSig);
    expect(result).toBe(false);
  });
});
