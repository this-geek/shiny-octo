import type { Context, Next } from 'hono';
import type { Env } from '../types.js';

const ALLOWED_METHODS = 'GET,POST,PUT,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type';
const PREFLIGHT_MAX_AGE = '86400';

function parseOrigins(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  );
}

export async function adminCors(
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  const origin = c.req.header('Origin');
  const allowed = parseOrigins(c.env.ADMIN_ORIGIN);
  const originAllowed = origin !== undefined && allowed.has(origin);

  if (c.req.method === 'OPTIONS') {
    const headers = new Headers();
    if (originAllowed && origin !== undefined) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Vary', 'Origin');
      headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
      headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      headers.set('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
    }
    return new Response(null, { status: 204, headers });
  }

  await next();

  if (originAllowed && origin !== undefined) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    const existingVary = c.res.headers.get('Vary');
    if (!existingVary) {
      c.res.headers.set('Vary', 'Origin');
    } else if (!existingVary.toLowerCase().split(/,\s*/).includes('origin')) {
      c.res.headers.set('Vary', `${existingVary}, Origin`);
    }
  }
}
