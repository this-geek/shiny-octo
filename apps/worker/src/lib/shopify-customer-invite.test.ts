import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CustomerInviteError, sendCustomerInvite } from './shopify-customer-invite.js';

describe('sendCustomerInvite', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): void {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch;
  }

  it('returns the customer id on success', async () => {
    mockFetch({
      data: {
        customerSendAccountInviteEmail: {
          customer: { id: 'gid://shopify/Customer/123' },
          customerUserErrors: [],
        },
      },
    });
    const r = await sendCustomerInvite('shop.myshopify.com', 't', '2026-04', 'gid://shopify/Customer/123');
    expect(r.customerId).toBe('gid://shopify/Customer/123');
  });

  it('throws CustomerInviteError on userErrors', async () => {
    mockFetch({
      data: {
        customerSendAccountInviteEmail: {
          customer: null,
          customerUserErrors: [{ message: 'Already invited', code: 'TAKEN' }],
        },
      },
    });
    await expect(
      sendCustomerInvite('shop.myshopify.com', 't', '2026-04', 'gid://shopify/Customer/1'),
    ).rejects.toThrow(/Already invited/);
  });

  it('throws on top-level graphql errors', async () => {
    mockFetch({ errors: [{ message: 'rate limited' }] });
    await expect(
      sendCustomerInvite('shop.myshopify.com', 't', '2026-04', 'gid://shopify/Customer/1'),
    ).rejects.toThrow(/rate limited/);
  });

  it('throws on non-200 HTTP', async () => {
    mockFetch({}, { ok: false, status: 503 });
    await expect(
      sendCustomerInvite('shop.myshopify.com', 't', '2026-04', 'gid://shopify/Customer/1'),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('rejects non-GID customer ids', async () => {
    await expect(
      sendCustomerInvite('shop.myshopify.com', 't', '2026-04', '12345'),
    ).rejects.toThrow(CustomerInviteError);
  });

  it('passes the correct mutation + variables', async () => {
    const spy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            customerSendAccountInviteEmail: {
              customer: { id: 'gid://shopify/Customer/9' },
              customerUserErrors: [],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    globalThis.fetch = spy as typeof fetch;
    await sendCustomerInvite('demo.myshopify.com', 'tok', '2026-04', 'gid://shopify/Customer/9');
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0];
    expect(call[0]).toBe('https://demo.myshopify.com/admin/api/2026-04/graphql.json');
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.variables).toEqual({ customerId: 'gid://shopify/Customer/9' });
    expect(body.query).toContain('customerSendAccountInviteEmail');
  });
});
