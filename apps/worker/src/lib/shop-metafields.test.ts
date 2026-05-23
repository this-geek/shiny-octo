import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setShopMetafield } from './shop-metafields.js';

describe('setShopMetafield', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('POSTs a metafieldsSet mutation with the right namespace/key/type/value', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            shop: { id: 'gid://shopify/Shop/12345' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            metafieldsSet: {
              metafields: [{ id: 'gid://shopify/Metafield/1', key: 'is_plus' }],
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await setShopMetafield(
      'example.myshopify.com',
      'shpat_token',
      '2026-04',
      'b2b',
      'is_plus',
      'boolean',
      'true',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, secondCall] = fetchMock.mock.calls;
    const [url, init] = secondCall as [string, RequestInit];
    expect(url).toBe('https://example.myshopify.com/admin/api/2026-04/graphql.json');
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_token');

    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: { metafields: Array<Record<string, string>> };
    };
    expect(body.query).toContain('metafieldsSet');
    expect(body.variables.metafields).toHaveLength(1);
    const mf = body.variables.metafields[0];
    expect(mf.namespace).toBe('b2b');
    expect(mf.key).toBe('is_plus');
    expect(mf.type).toBe('boolean');
    expect(mf.value).toBe('true');
    expect(mf.ownerId).toBe('gid://shopify/Shop/12345');
  });

  it('throws when metafieldsSet returns userErrors', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { shop: { id: 'gid://shopify/Shop/1' } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            metafieldsSet: {
              metafields: [],
              userErrors: [{ field: ['value'], message: 'Invalid value', code: 'INVALID' }],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      setShopMetafield(
        'example.myshopify.com',
        'shpat_token',
        '2026-04',
        'b2b',
        'is_plus',
        'boolean',
        'true',
      ),
    ).rejects.toThrow(/Invalid value/);
  });

  it('throws when GraphQL request fails', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response('Internal error', { status: 500 }),
    );

    await expect(
      setShopMetafield(
        'example.myshopify.com',
        'shpat_token',
        '2026-04',
        'b2b',
        'is_plus',
        'boolean',
        'true',
      ),
    ).rejects.toThrow();
  });
});
