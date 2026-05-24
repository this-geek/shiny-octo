import { describe, it, expect } from 'vitest';
import { decryptForm, encryptForm } from './application-store.js';

const SHOP = 'demo.myshopify.com';
const KEY = '00'.repeat(32);

describe('application-store crypto round-trip', () => {
  it('encrypts and decrypts a form payload', async () => {
    const form = {
      fields: { businessName: 'Acme', resaleCert: 'yes' },
      email: 'buyer@example.com',
      countryCode: 'nz',
      taxId: '136410132',
      companyName: 'Acme Pty',
      documents: [
        { name: 'license.pdf', r2_key: 'shops/7/applications/1/license.pdf', size: 1024, mime: 'application/pdf' },
      ],
    };
    const blob = await encryptForm(form, SHOP, KEY);
    const out = await decryptForm(blob, SHOP, KEY);
    expect(out.fields.businessName).toBe('Acme');
    expect(out.email).toBe('buyer@example.com');
    expect(out.taxId).toBe('136410132');
    expect(out.documents).toHaveLength(1);
    expect(out.documents[0].r2_key).toBe('shops/7/applications/1/license.pdf');
  });

  it('decryptForm returns an empty form on a corrupt blob', async () => {
    const out = await decryptForm('not-base64!!!', SHOP, KEY);
    expect(out.fields).toEqual({});
    expect(out.email).toBe('');
    expect(out.documents).toEqual([]);
  });

  it('a blob encrypted for shop A is unreadable as shop B', async () => {
    const form = { fields: {}, email: 'a@b.com', documents: [] };
    const blob = await encryptForm(form, SHOP, KEY);
    const out = await decryptForm(blob, 'other.myshopify.com', KEY);
    // Decryption throws inside; decryptForm catches and returns the empty form
    expect(out.email).toBe('');
  });
});
