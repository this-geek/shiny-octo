/**
 * Session-token verification for Customer Account UI extensions.
 *
 * Shopify's Customer Account UI runtime calls `sessionToken.get()` to mint
 * an HS256 JWT signed with the app's API secret (same algorithm as App
 * Bridge admin tokens, different payload shape). The Customer Account
 * runtime puts:
 *   - `iss`: the shop's customer-account host (e.g. https://shopify.com/<shop-id>)
 *   - `dest`: the shop URL (https://<shop>.myshopify.com)
 *   - `aud`: the app's API key
 *   - `sub`: the buyer's customer GID (gid://shopify/Customer/<id>)
 *
 * We verify the signature + the standard claims (aud, exp, nbf) and pull
 * shop_domain + customer_id back out. iss is not pinned — Shopify has
 * shipped multiple iss hosts over the customer-account API's lifetime.
 *
 * Reference:
 *   https://shopify.dev/docs/api/customer-account-ui-extensions/apis/session-token
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types.js';

interface CustomerAccountPayload {
  iss?: string;
  dest: string;
  aud: string;
  sub: string;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  const b64 = pad ? padded + '='.repeat(4 - pad) : padded;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function verifyHS256(token: string, secret: string): Promise<CustomerAccountPayload> {
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

  if (expectedB64.length !== signatureB64.length) throw new Error('Invalid signature');
  let diff = 0;
  for (let i = 0; i < expectedB64.length; i++) {
    diff |= expectedB64.charCodeAt(i) ^ signatureB64.charCodeAt(i);
  }
  if (diff !== 0) throw new Error('Invalid signature');

  return JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as CustomerAccountPayload;
}

export interface CustomerAccountContext {
  shop_domain: string;
  customer_id: string;
  raw: CustomerAccountPayload;
}

export async function verifyCustomerAccountToken(
  token: string,
  apiKey: string,
  apiSecret: string,
): Promise<CustomerAccountContext> {
  const payload = await verifyHS256(token, apiSecret);
  const nowSecs = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSecs) throw new Error('Session token expired');
  if (payload.nbf > nowSecs + 10) throw new Error('Session token not yet valid');
  if (payload.aud !== apiKey) throw new Error('Invalid audience');
  if (!payload.dest || !payload.sub) throw new Error('Missing required claims');

  const destUrl = new URL(payload.dest);
  return {
    shop_domain: destUrl.hostname,
    customer_id: payload.sub,
    raw: payload,
  };
}

export function customerAccountTokenMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return Promise.resolve(c.text('Unauthorized', 401));
  }
  const token = authHeader.slice(7);
  return verifyCustomerAccountToken(token, c.env.SHOPIFY_API_KEY, c.env.SHOPIFY_API_SECRET)
    .then(ctx => {
      c.set('customerAccount', ctx);
      return next();
    })
    .catch(() => c.text('Unauthorized', 401));
}

declare module 'hono' {
  interface ContextVariableMap {
    customerAccount: CustomerAccountContext;
  }
}
