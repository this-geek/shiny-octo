import type { Context, Next } from 'hono';
import type { Env } from '../types.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { log } from '../lib/logger.js';

/** Per-shop ceiling on session-token-authed admin traffic. */
export const ADMIN_LIMIT_PER_MIN = 100;
/** Per-IP ceiling on App-Proxy / buyer-portal traffic. */
export const PUBLIC_LIMIT_PER_MIN = 10;

const UNKNOWN_IP = 'unknown';

function clientIp(c: Context<{ Bindings: Env }>): string {
  return c.req.header('CF-Connecting-IP') ?? UNKNOWN_IP;
}

function denyResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: 'rate_limited' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(retryAfterSeconds),
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Per-shop admin rate limiter. Must run AFTER `sessionTokenMiddleware` so
 * `shopDomain` is on the context.
 */
export async function adminRateLimit(
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  const shopDomain = c.get('shopDomain');
  if (!shopDomain) return next();
  let r;
  try {
    r = await checkRateLimit(c.env.KV_HOT_CACHE, 'admin', shopDomain, ADMIN_LIMIT_PER_MIN);
  } catch (err) {
    // Fail open: a KV outage must not take down the admin.
    log('error', 'rate-limit: admin KV unavailable, allowing', {
      shop: shopDomain,
      error: String(err),
    });
    return next();
  }
  if (!r.allowed) {
    log('warn', 'rate-limit: admin denied', {
      shop: shopDomain,
      count: r.count,
      limit: r.limit,
    });
    return denyResponse(r.retryAfterSeconds);
  }
  return next();
}

/**
 * Per-IP public rate limiter for App-Proxy / buyer-facing routes. Place
 * BEFORE more expensive middleware (HMAC, DB lookups) so a flood is shed
 * cheaply.
 */
export async function publicRateLimit(
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  const ip = clientIp(c);
  let r;
  try {
    r = await checkRateLimit(c.env.KV_HOT_CACHE, 'public', ip, PUBLIC_LIMIT_PER_MIN);
  } catch (err) {
    log('error', 'rate-limit: public KV unavailable, allowing', { error: String(err) });
    return next();
  }
  if (!r.allowed) {
    log('warn', 'rate-limit: public denied', {
      ip_hash: ip === UNKNOWN_IP ? 'unknown' : await hashIp(ip),
      count: r.count,
      limit: r.limit,
    });
    return denyResponse(r.retryAfterSeconds);
  }
  return next();
}

async function hashIp(ip: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(buf).slice(0, 8))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
