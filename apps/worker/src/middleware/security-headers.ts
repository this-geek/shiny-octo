import type { Context, Next } from 'hono';
import type { Env } from '../types.js';
import { applyBuyerHtmlSecurityHeaders, isHtmlResponse } from '../lib/security-headers.js';

/**
 * Applies the buyer-HTML CSP + common security headers to every text/html
 * response that flows through this middleware. JSON / JS / CSS / asset
 * responses are left untouched (CSP is meaningless on them and would only
 * cost header bytes).
 */
export async function securityHeadersMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  await next();
  if (c.res && isHtmlResponse(c.res)) {
    applyBuyerHtmlSecurityHeaders(c.res.headers);
  }
}
