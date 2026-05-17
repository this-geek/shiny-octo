import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from './crypto.js';

// 256-bit master key in hex (32 bytes = 64 hex chars) — test-only value
const MASTER_KEY = 'a'.repeat(64);
const SHOP_A = 'shop-a.myshopify.com';
const SHOP_B = 'shop-b.myshopify.com';

describe('encrypt / decrypt', () => {
  it('round-trip: encrypt then decrypt returns original plaintext', async () => {
    const plaintext = 'shpat_super_secret_access_token';
    const enc = await encrypt(plaintext, SHOP_A, MASTER_KEY);
    const dec = await decrypt(enc, SHOP_A, MASTER_KEY);
    expect(dec).toBe(plaintext);
  });

  it('round-trip works with unicode and long strings', async () => {
    const plaintext = 'こんにちは world — token_' + 'x'.repeat(512);
    const enc = await encrypt(plaintext, SHOP_A, MASTER_KEY);
    const dec = await decrypt(enc, SHOP_A, MASTER_KEY);
    expect(dec).toBe(plaintext);
  });

  it('different shops get different ciphertexts (different HKDF-derived keys)', async () => {
    const plaintext = 'same-plaintext';
    const encA = await encrypt(plaintext, SHOP_A, MASTER_KEY);
    const encB = await encrypt(plaintext, SHOP_B, MASTER_KEY);
    expect(encA).not.toBe(encB);
  });

  it('wrong shop domain fails to decrypt (throws)', async () => {
    const enc = await encrypt('secret', SHOP_A, MASTER_KEY);
    await expect(decrypt(enc, SHOP_B, MASTER_KEY)).rejects.toThrow();
  });

  it('wrong master key fails to decrypt (throws)', async () => {
    const enc = await encrypt('secret', SHOP_A, MASTER_KEY);
    const wrongKey = 'b'.repeat(64);
    await expect(decrypt(enc, SHOP_A, wrongKey)).rejects.toThrow();
  });

  it('invalid (too-short) base64 payload throws', async () => {
    // 12 bytes = 16 base64 chars is exactly the nonce with 0 ciphertext bytes,
    // which is < 13 bytes total check (nonce=12, need at least 1 byte ciphertext)
    // Use an explicitly short payload
    await expect(decrypt('dG9vc2hvcnQ=', SHOP_A, MASTER_KEY)).rejects.toThrow();
  });

  it('tampered ciphertext fails to decrypt', async () => {
    const enc = await encrypt('original', SHOP_A, MASTER_KEY);
    // Flip a character in the middle of the base64 string
    const mid = Math.floor(enc.length / 2);
    const tampered = enc.slice(0, mid) + (enc[mid] === 'A' ? 'B' : 'A') + enc.slice(mid + 1);
    await expect(decrypt(tampered, SHOP_A, MASTER_KEY)).rejects.toThrow();
  });

  it('different plaintexts produce different ciphertexts (nonce randomness)', async () => {
    // Even the same plaintext encrypted twice should differ due to random nonce
    const plaintext = 'same';
    const enc1 = await encrypt(plaintext, SHOP_A, MASTER_KEY);
    const enc2 = await encrypt(plaintext, SHOP_A, MASTER_KEY);
    expect(enc1).not.toBe(enc2);
  });

  it('throws on invalid hex master key', async () => {
    await expect(encrypt('x', SHOP_A, 'not-valid-hex!!!')).rejects.toThrow();
  });
});
