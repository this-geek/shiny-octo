import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { securityHeadersMiddleware } from './security-headers.js';

function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', securityHeadersMiddleware);
  app.get('/html', c => c.html('<!doctype html><html><body>hi</body></html>'));
  app.get('/json', c => c.json({ ok: true }));
  app.get('/js', c =>
    new Response('console.log(1)', {
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    }),
  );
  app.get('/css', c =>
    new Response('body{}', { headers: { 'Content-Type': 'text/css' } }),
  );
  app.get('/html-pre-csp', c =>
    new Response('<!doctype html>', {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'",
      },
    }),
  );
  return app;
}

describe('securityHeadersMiddleware', () => {
  it('adds CSP + nosniff + no-store to HTML responses', async () => {
    const res = await buildApp().request('/html');
    expect(res.headers.get('Content-Security-Policy')).toMatch(/default-src 'self'/);
    expect(res.headers.get('Content-Security-Policy')).not.toMatch(/unsafe-inline/);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Robots-Tag')).toMatch(/noindex/);
  });

  it('does NOT add CSP to JSON responses', async () => {
    const res = await buildApp().request('/json');
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('does NOT add CSP to JS or CSS responses', async () => {
    const jsRes = await buildApp().request('/js');
    const cssRes = await buildApp().request('/css');
    expect(jsRes.headers.get('Content-Security-Policy')).toBeNull();
    expect(cssRes.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('does not clobber a route-set CSP', async () => {
    const res = await buildApp().request('/html-pre-csp');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
  });
});
