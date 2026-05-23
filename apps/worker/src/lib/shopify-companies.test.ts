import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listShopifyCompanies } from './shopify-companies.js';

function makeResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('listShopifyCompanies', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns companies from a single page', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        data: {
          companies: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [
              { node: { id: 'gid://shopify/Company/1', name: 'Alpha' } },
              { node: { id: 'gid://shopify/Company/2', name: 'Bravo' } },
            ],
          },
        },
      }),
    );

    const result = await listShopifyCompanies('example.myshopify.com', 'shpat_t', '2026-04');
    expect(result.truncated).toBe(false);
    expect(result.companies).toEqual([
      { id: 'gid://shopify/Company/1', name: 'Alpha' },
      { id: 'gid://shopify/Company/2', name: 'Bravo' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('https://example.myshopify.com/admin/api/2026-04/graphql.json');
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body.variables).toEqual({ cursor: null });
  });

  it('paginates with endCursor when hasNextPage is true', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        data: {
          companies: {
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            edges: [{ node: { id: 'gid://shopify/Company/1', name: 'Alpha' } }],
          },
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        data: {
          companies: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [{ node: { id: 'gid://shopify/Company/2', name: 'Bravo' } }],
          },
        },
      }),
    );

    const result = await listShopifyCompanies('example.myshopify.com', 'shpat_t', '2026-04');
    expect(result.companies).toHaveLength(2);
    expect(result.truncated).toBe(false);

    const secondCall = fetchMock.mock.calls[1];
    const secondBody = JSON.parse((secondCall[1] as { body: string }).body);
    expect(secondBody.variables).toEqual({ cursor: 'cursor-1' });
  });

  it('throws on non-2xx HTTP', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(
      listShopifyCompanies('example.myshopify.com', 'shpat_t', '2026-04'),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws when GraphQL returns errors', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      makeResponse({ errors: [{ message: 'Access denied' }] }),
    );
    await expect(
      listShopifyCompanies('example.myshopify.com', 'shpat_t', '2026-04'),
    ).rejects.toThrow(/Access denied/);
  });
});
