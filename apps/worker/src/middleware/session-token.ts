/**
 * Session token verification for Shopify App Bridge embedded admin requests.
 *
 * App Bridge sends a JWT as the Authorization: Bearer header on every
 * authenticated admin route. We verify the token's claims (iss, dest, exp)
 * to protect admin API routes from unauthorised access.
 *
 * The token is signed with the app's API secret (HS256 for most apps).
 * ES256 / RS256 are used for some partner-API flows — not implemented here;
 * add when a concrete need arises.
 *
 * Reference:
 *   https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens/getting-started
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types.js';

interface SessionTokenPayload {
  iss: string;
  dest: string;
  aud: string;
  sub: string;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  sid: string;
}

function base64UrlDecode(input: string): Uint8Array {
  // Pad to a multiple of 4 and replace URL-safe chars
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  const b64 = pad ? padded + '='.repeat(4 - pad) : padded;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function verifyHS256(token: string, secret: string): Promise<SessionTokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT structure');

  const [headerB64, payloadB64, signatureB64] = parts;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput),
  );
  const expectedB64 = btoa(String.fromCharCode(...new Uint8Array(expectedSig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  // Timing-safe comparison
  if (expectedB64.length !== signatureB64.length) {
    throw new Error('Invalid signature');
  }
  let diff = 0;
  for (let i = 0; i < expectedB64.length; i++) {
    diff |= expectedB64.charCodeAt(i) ^ signatureB64.charCodeAt(i);
  }
  if (diff !== 0) throw new Error('Invalid signature');

  const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
  return JSON.parse(payloadJson) as SessionTokenPayload;
}

/**
 * Verify a Shopify App Bridge session token JWT.
 * Returns the decoded payload on success; throws on failure.
 */
export async function verifySessionToken(
  token: string,
  apiKey: string,
  apiSecret: string,
): Promise<SessionTokenPayload> {
  const payload = await verifyHS256(token, apiSecret);

  const nowSecs = Math.floor(Date.now() / 1000);

  if (payload.exp < nowSecs) {
    throw new Error('Session token expired');
  }

  if (payload.nbf > nowSecs + 10) {
    // Allow 10s clock skew
    throw new Error('Session token not yet valid');
  }

  if (!payload.iss || !payload.dest) {
    throw new Error('Missing required claims');
  }

  // iss should be the shop domain URL, dest should match
  const issUrl = new URL(payload.iss);
  const destUrl = new URL(payload.dest);
  if (issUrl.hostname !== destUrl.hostname) {
    throw new Error('iss/dest hostname mismatch');
  }

  // aud should contain our API key
  if (payload.aud !== apiKey) {
    throw new Error('Invalid audience');
  }

  return payload;
}

/**
 * Extract the shop domain from a session-token payload's `dest` claim.
 * `dest` is the canonical shop URL (https://example.myshopify.com); we strip
 * the protocol so callers can scope D1/KV lookups by `shopify_domain`.
 */
export function shopDomainFromPayload(payload: SessionTokenPayload): string {
  return new URL(payload.dest).hostname;
}

/**
 * Hono middleware for admin routes that require a valid App Bridge session token.
 * On success, attaches the decoded payload + shop_domain to c.var.
 * Usage: app.use('/admin/*', sessionTokenMiddleware)
 */
export function sessionTokenMiddleware(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return Promise.resolve(c.text('Unauthorized', 401));
  }
  const token = authHeader.slice(7);
  return verifySessionToken(token, c.env.SHOPIFY_API_KEY, c.env.SHOPIFY_API_SECRET)
    .then(payload => {
      c.set('sessionPayload', payload);
      c.set('shopDomain', shopDomainFromPayload(payload));
      c.set('sessionToken', token);
      return next();
    })
    .catch(() => c.text('Unauthorized', 401));
}

declare module 'hono' {
  interface ContextVariableMap {
    sessionPayload: SessionTokenPayload;
    shopDomain: string;
    sessionToken: string;
  }
}
