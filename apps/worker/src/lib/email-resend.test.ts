import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  RecognisedSendError,
  RetryableSendError,
  renderTemplate,
  sendEmail,
} from './email-resend.js';

describe('renderTemplate', () => {
  it('substitutes simple variables', () => {
    expect(renderTemplate('Hi {{name}}!', { name: 'Sam' })).toBe('Hi Sam!');
  });

  it('html-escapes variable values', () => {
    expect(renderTemplate('<p>{{name}}</p>', { name: '<script>alert(1)</script>' })).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('treats missing variables as empty', () => {
    expect(renderTemplate('Hi {{name}}', {})).toBe('Hi ');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('Hi {{ name }}', { name: 'Sam' })).toBe('Hi Sam');
  });

  it('leaves non-matching curlies alone', () => {
    expect(renderTemplate('{not a var}', {})).toBe('{not a var}');
  });
});

describe('sendEmail', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const baseInput = {
    from: 'b2b@example.com',
    to: 'buyer@example.com',
    subject: 'Hello',
    html: '<p>Hi</p>',
  };

  it('throws RecognisedSendError when API key is missing', async () => {
    await expect(sendEmail(undefined, baseInput)).rejects.toThrow(RecognisedSendError);
  });

  it('returns id on 200', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'em_123' }), { status: 200 }));
    const r = await sendEmail('key', baseInput);
    expect(r.id).toBe('em_123');
  });

  it('throws RecognisedSendError on 4xx', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"message":"unauthorised"}', { status: 401 }));
    await expect(sendEmail('key', baseInput)).rejects.toThrow(RecognisedSendError);
  });

  it('throws RetryableSendError on 5xx', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"message":"upstream"}', { status: 502 }));
    await expect(sendEmail('key', baseInput)).rejects.toThrow(RetryableSendError);
  });

  it('throws RetryableSendError on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection reset'));
    await expect(sendEmail('key', baseInput)).rejects.toThrow(RetryableSendError);
  });
});
