import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exchangeForOfflineToken } from './token-exchange.js';

const SHOP = 'demo.myshopify.com';
const SESSION_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.fake.payload';
const CLIENT_ID = 'api-key';
const CLIENT_SECRET = 'api-secret';

describe('exchangeForOfflineToken', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('POSTs the RFC 8693 token-exchange payload and returns the offline token', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'shpat_offline_123', scope: 'read_products' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const token = await exchangeForOfflineToken({
      shopDomain: SHOP,
      sessionToken: SESSION_TOKEN,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(token).toBe('shpat_offline_123');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: SESSION_TOKEN,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    });
  });

  it('throws when Shopify returns a non-2xx', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response('invalid_subject_token', { status: 400 }),
    );

    await expect(
      exchangeForOfflineToken({
        shopDomain: SHOP,
        sessionToken: SESSION_TOKEN,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      }),
    ).rejects.toThrow(/Token exchange failed: 400/);
  });

  it('throws when the response is missing access_token', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ scope: 'read_products' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      exchangeForOfflineToken({
        shopDomain: SHOP,
        sessionToken: SESSION_TOKEN,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      }),
    ).rejects.toThrow(/missing access_token/);
  });
});
