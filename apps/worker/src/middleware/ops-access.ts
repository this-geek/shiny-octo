/**
 * Cloudflare Access gate for `/_ops/*` routes.
 *
 * Verifies the `Cf-Access-Jwt-Assertion` JWT against the team's JWKS
 * (RS256). On success, exposes `operatorEmail` on the context. On any
 * failure — including missing/invalid env config — refuses the request.
 *
 * We never trust the `Cf-Access-Authenticated-User-Email` header on its
 * own: that header is set by the CF Access proxy but anyone hitting the
 * Worker directly (bypassing Access) could forge it. JWT verification
 * is what makes this header trustworthy.
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types.js';
import { OpsAccessError, verifyAccessJwt } from '../lib/cf-access.js';
import { log } from '../lib/logger.js';

export function opsAccessMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  const team = c.env.OPS_ACCESS_TEAM;
  const aud = c.env.OPS_ACCESS_AUD;
  if (!team || !aud) {
    log('warn', '_ops: OPS_ACCESS_TEAM / OPS_ACCESS_AUD not configured; refusing');
    return Promise.resolve(c.json({ error: 'ops console not configured' }, 503));
  }

  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) {
    return Promise.resolve(c.json({ error: 'missing Cf-Access-Jwt-Assertion' }, 401));
  }

  return verifyAccessJwt({
    token,
    team,
    expectedAud: aud,
    kv: c.env.KV_HOT_CACHE,
  })
    .then(identity => {
      c.set('operatorEmail', identity.email);
      return next();
    })
    .catch(err => {
      const reason = err instanceof OpsAccessError ? err.message : 'verification failed';
      log('warn', '_ops: access denied', { reason });
      return c.json({ error: 'forbidden' }, 403);
    });
}

declare module 'hono' {
  interface ContextVariableMap {
    operatorEmail: string;
  }
}
