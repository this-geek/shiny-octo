import { createMiddleware } from 'hono/factory';
import type { Env } from '../types.js';

/**
 * App Proxy signature verification differs from webhook HMAC:
 *   - Drop the `signature` param
 *   - Sort remaining keys alphabetically
 *   - Concatenate `key=value` pairs with NO separator (no `&`)
 *   - Multi-value params: join values with `,`
 *   - HMAC-SHA256 with the app's API secret, hex-encoded
 *   - Compare hex digests in constant time
 *
 * https://shopify.dev/docs/apps/build/online-store/display-dynamic-data
 */
export async function verifyAppProxySignature(
  params: URLSearchParams,
  apiSecret: string,
): Promise<boolean> {
  const provided = params.get('signature');
  if (!provided) return false;

  const grouped: Record<string, string[]> = {};
  for (const [key, value] of params.entries()) {
    if (key === 'signature') continue;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(value);
  }

  const sortedKeys = Object.keys(grouped).sort();
  const message = sortedKeys.map(k => `${k}=${grouped[k].join(',')}`).join('');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const computed = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  if (computed.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export const appProxyMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const url = new URL(c.req.url);
  const valid = await verifyAppProxySignature(url.searchParams, c.env.SHOPIFY_API_SECRET);
  if (!valid) return c.text('Unauthorized', 401);
  await next();
});
