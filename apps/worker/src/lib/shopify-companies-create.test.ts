import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  CompanyCreateError,
  buildIdempotencyKey,
  createCompanyForApplication,
} from './shopify-companies-create.js';

describe('buildIdempotencyKey', () => {
  it('combines shop and application id', () => {
    expect(buildIdempotencyKey('demo.myshopify.com', 7)).toBe(
      'b2b-companion:approve:demo.myshopify.com:app-7',
    );
  });

  it('is stable for the same inputs', () => {
    const a = buildIdempotencyKey('s.myshopify.com', 1);
    const b = buildIdempotencyKey('s.myshopify.com', 1);
    expect(a).toBe(b);
  });

  it('differs across shops', () => {
    expect(buildIdempotencyKey('a.myshopify.com', 1)).not.toBe(
      buildIdempotencyKey('b.myshopify.com', 1),
    );
  });
});

describe('createCompanyForApplication', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends X-Idempotency-Key on the wire', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            companyCreate: {
              company: {
                id: 'gid://shopify/Company/1',
                mainContact: {
                  id: 'gid://shopify/CompanyContact/2',
                  customer: { id: 'gid://shopify/Customer/3' },
                },
                locations: { nodes: [{ id: 'gid://shopify/CompanyLocation/4' }] },
              },
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    const result = await createCompanyForApplication('demo.myshopify.com', 'tok', '2026-04', {
      email: 'a@b.com',
      companyName: 'Acme',
      externalApplicationId: 99,
    });

    expect(result.companyId).toBe('gid://shopify/Company/1');
    expect(result.locationId).toBe('gid://shopify/CompanyLocation/4');
    expect(result.contactId).toBe('gid://shopify/CompanyContact/2');
    expect(result.customerId).toBe('gid://shopify/Customer/3');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Idempotency-Key']).toBe(
      'b2b-companion:approve:demo.myshopify.com:app-99',
    );
    expect(headers['X-Shopify-Access-Token']).toBe('tok');
  });

  it('throws CompanyCreateError when Shopify returns top-level errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ errors: [{ message: 'throttled' }] }),
        { status: 200 },
      ),
    );
    await expect(
      createCompanyForApplication('demo.myshopify.com', 'tok', '2026-04', {
        email: 'a@b.com',
        companyName: 'Acme',
        externalApplicationId: 1,
      }),
    ).rejects.toThrow(CompanyCreateError);
  });

  it('throws CompanyCreateError with userErrors when Shopify rejects the input', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            companyCreate: {
              company: null,
              userErrors: [{ message: 'name is too short', code: 'TOO_SHORT' }],
            },
          },
        }),
        { status: 200 },
      ),
    );
    try {
      await createCompanyForApplication('demo.myshopify.com', 'tok', '2026-04', {
        email: 'a@b.com',
        companyName: 'X',
        externalApplicationId: 2,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CompanyCreateError);
      expect((err as CompanyCreateError).userErrors[0].code).toBe('TOO_SHORT');
    }
  });

  it('throws on a non-200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 502 }));
    await expect(
      createCompanyForApplication('demo.myshopify.com', 'tok', '2026-04', {
        email: 'a@b.com',
        companyName: 'Acme',
        externalApplicationId: 1,
      }),
    ).rejects.toThrow(/HTTP 502/);
  });
});
