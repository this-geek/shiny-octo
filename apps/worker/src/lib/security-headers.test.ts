import { describe, it, expect } from 'vitest';
import {
  BUYER_HTML_CSP,
  applyBuyerHtmlSecurityHeaders,
  isHtmlResponse,
} from './security-headers.js';

describe('security-headers: BUYER_HTML_CSP', () => {
  it('disallows inline scripts (no unsafe-inline in script-src)', () => {
    const directives = BUYER_HTML_CSP.split(';').map(d => d.trim());
    const scriptSrc = directives.find(d => d.startsWith('script-src'))!;
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toMatch(/unsafe-inline/);
    expect(scriptSrc).not.toMatch(/unsafe-eval/);
  });

  it('locks default-src to self', () => {
    expect(BUYER_HTML_CSP).toMatch(/default-src 'self'/);
  });

  it('allows Shopify origins to frame the portal', () => {
    expect(BUYER_HTML_CSP).toMatch(/frame-ancestors[^;]*\*\.myshopify\.com/);
    expect(BUYER_HTML_CSP).toMatch(/frame-ancestors[^;]*\*\.shopify\.com/);
  });

  it('forbids base-uri and locks form-action to self', () => {
    expect(BUYER_HTML_CSP).toMatch(/base-uri 'none'/);
    expect(BUYER_HTML_CSP).toMatch(/form-action 'self'/);
  });
});

describe('security-headers: applyBuyerHtmlSecurityHeaders', () => {
  it('sets CSP, nosniff, referrer policy, robots, and no-store', () => {
    const h = new Headers();
    applyBuyerHtmlSecurityHeaders(h);
    expect(h.get('Content-Security-Policy')).toBe(BUYER_HTML_CSP);
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
    expect(h.get('Referrer-Policy')).toBe('no-referrer');
    expect(h.get('X-Robots-Tag')).toMatch(/noindex/);
    expect(h.get('Cache-Control')).toMatch(/no-store/);
  });

  it('does not clobber pre-existing values', () => {
    const h = new Headers();
    h.set('Cache-Control', 'public, max-age=60');
    h.set('Content-Security-Policy', "default-src 'none'");
    applyBuyerHtmlSecurityHeaders(h);
    expect(h.get('Cache-Control')).toBe('public, max-age=60');
    expect(h.get('Content-Security-Policy')).toBe("default-src 'none'");
  });
});

describe('security-headers: isHtmlResponse', () => {
  it('returns true for text/html responses with or without charset', () => {
    expect(
      isHtmlResponse(new Response('', { headers: { 'Content-Type': 'text/html' } })),
    ).toBe(true);
    expect(
      isHtmlResponse(
        new Response('', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      ),
    ).toBe(true);
  });

  it('returns false for JSON, JS, CSS', () => {
    expect(
      isHtmlResponse(new Response('{}', { headers: { 'Content-Type': 'application/json' } })),
    ).toBe(false);
    expect(
      isHtmlResponse(
        new Response('', { headers: { 'Content-Type': 'application/javascript' } }),
      ),
    ).toBe(false);
    expect(
      isHtmlResponse(new Response('', { headers: { 'Content-Type': 'text/css' } })),
    ).toBe(false);
  });

  it('returns false when Content-Type is missing', () => {
    expect(isHtmlResponse(new Response(''))).toBe(false);
  });
});
