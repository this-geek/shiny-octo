import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { action } from './dismiss-plus-banner.js';

type ActionArgs = Parameters<typeof action>[0];

function makeArgs(form: Record<string, string>, env: Record<string, string>): ActionArgs {
  const body = new URLSearchParams(form).toString();
  const request = new Request('https://admin.example/dismiss-plus-banner', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  return { request, context: { cloudflare: { env } }, params: {} } as unknown as ActionArgs;
}

describe('dismiss-plus-banner action (SSRF regression)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ignores attacker-supplied workerBase and uses env WORKER_URL', async () => {
    const args = makeArgs(
      { workerBase: 'http://169.254.169.254', idToken: 'tok' },
      { WORKER_URL: 'https://worker.example' },
    );
    const res = await action(args);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://worker.example/admin/plus-banner/dismiss');
  });

  it('returns 400 when idToken is missing', async () => {
    const args = makeArgs({}, { WORKER_URL: 'https://worker.example' });
    const res = await action(args);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 500 when WORKER_URL is not configured server-side', async () => {
    const args = makeArgs({ idToken: 'tok' }, {});
    const res = await action(args);
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to APP_URL when WORKER_URL is unset', async () => {
    const args = makeArgs({ idToken: 'tok' }, { APP_URL: 'https://app.example' });
    const res = await action(args);
    expect(res.status).toBe(200);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://app.example/admin/plus-banner/dismiss');
  });
});
