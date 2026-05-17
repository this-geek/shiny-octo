import { createMiddleware } from 'hono/factory';
import type { Env } from '../types.js';

/**
 * Timing-safe string comparison (constant time relative to string length).
 * Both strings must be the same length for a meaningful comparison.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the HMAC-SHA256 signature of a raw webhook body.
 * The `signature` should be the base64-encoded value from X-Shopify-Hmac-Sha256.
 */
export async function verifyWebhookHmac(
  secret: string,
  body: ArrayBuffer,
  signature: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, body);
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return timingSafeEqual(expected, signature);
}

/**
 * Hono middleware that verifies the Shopify webhook HMAC before passing to handler.
 * MUST be applied to all webhook routes. Raw body is read before parsing.
 */
export const webhookHmacMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const signature = c.req.header('X-Shopify-Hmac-Sha256');
  if (!signature) return c.text('Unauthorized', 401);
  const body = await c.req.raw.clone().arrayBuffer();
  const valid = await verifyWebhookHmac(c.env.SHOPIFY_API_SECRET, body, signature);
  if (!valid) return c.text('Unauthorized', 401);
  await next();
});
