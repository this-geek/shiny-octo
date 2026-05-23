import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  B2B_METAFIELD_DEFINITIONS,
  ensureMetafieldDefinitions,
} from './metafield-definitions.js';

describe('B2B_METAFIELD_DEFINITIONS', () => {
  it('contains the 8 expected definitions', () => {
    expect(B2B_METAFIELD_DEFINITIONS).toHaveLength(8);
    const keys = B2B_METAFIELD_DEFINITIONS.map(d => `${d.namespace}.${d.key}`);
    expect(keys).toContain('b2b.b2b_only');
    expect(keys).toContain('b2b.case_quantity');
    expect(keys).toContain('b2b.min_order_qty');
    expect(keys).toContain('b2b.max_order_qty');
    expect(keys).toContain('b2b.tier_id');
    expect(keys).toContain('b2b.is_plus');
    expect(keys).toContain('b2b.app_proxy_path');
    expect(keys).toContain('b2b.tiers_config');
  });
});

describe('ensureMetafieldDefinitions', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function okResponse(): Response {
    return new Response(
      JSON.stringify({
        data: {
          metafieldDefinitionCreate: {
            createdDefinition: { id: 'gid://shopify/MetafieldDefinition/1' },
            userErrors: [],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  function takenResponse(): Response {
    return new Response(
      JSON.stringify({
        data: {
          metafieldDefinitionCreate: {
            createdDefinition: null,
            userErrors: [
              { field: ['definition', 'key'], message: 'Key is in use', code: 'TAKEN' },
            ],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('POSTs metafieldDefinitionCreate once per definition', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    for (let i = 0; i < B2B_METAFIELD_DEFINITIONS.length; i++) {
      fetchMock.mockResolvedValueOnce(okResponse());
    }
    await ensureMetafieldDefinitions('example.myshopify.com', 'token', '2026-04');
    expect(fetchMock).toHaveBeenCalledTimes(B2B_METAFIELD_DEFINITIONS.length);

    const namespaces: string[] = [];
    const keys: string[] = [];
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      const body = JSON.parse(init.body as string) as {
        variables: { definition: { namespace: string; key: string } };
      };
      namespaces.push(body.variables.definition.namespace);
      keys.push(body.variables.definition.key);
    }
    expect(keys).toContain('b2b_only');
    expect(keys).toContain('tier_id');
    expect(keys).toContain('is_plus');
    expect(namespaces.every(n => n === 'b2b')).toBe(true);
  });

  it('swallows TAKEN errors (idempotent)', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    for (let i = 0; i < B2B_METAFIELD_DEFINITIONS.length; i++) {
      fetchMock.mockResolvedValueOnce(takenResponse());
    }
    await expect(
      ensureMetafieldDefinitions('example.myshopify.com', 'token', '2026-04'),
    ).resolves.toBeUndefined();
  });

  it('propagates non-TAKEN userErrors', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            metafieldDefinitionCreate: {
              createdDefinition: null,
              userErrors: [{ field: ['type'], message: 'Invalid type', code: 'INVALID_TYPE' }],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(
      ensureMetafieldDefinitions('example.myshopify.com', 'token', '2026-04'),
    ).rejects.toThrow(/Invalid type/);
  });

  it('propagates HTTP errors', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(
      ensureMetafieldDefinitions('example.myshopify.com', 'token', '2026-04'),
    ).rejects.toThrow();
  });
});
