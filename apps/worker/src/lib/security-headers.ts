/**
 * Centralised CSP + common security headers for every HTML response the
 * Worker serves (buyer dealer portal, app-proxy HTML pages). Functions
 * mutate the response's Headers in place.
 *
 * The CSP is strict-by-default: no inline scripts, no inline styles,
 * `default-src 'self'`. The buyer portal ships JSON boot data in a
 * `<script type="application/json">` tag, which CSP treats as data (not
 * executable), so no exception is needed.
 *
 * `frame-ancestors` allows Shopify storefronts to embed the portal via
 * App Proxy (same-origin from the customer's perspective is the merchant's
 * domain, but Shopify also iframes apps from *.myshopify.com /
 * admin.shopify.com); kept permissive for those origins only.
 */

export const BUYER_HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'self' https://*.myshopify.com https://*.shopify.com",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

export function applyBuyerHtmlSecurityHeaders(headers: Headers): void {
  for (const [k, v] of Object.entries(COMMON_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  if (!headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', BUYER_HTML_CSP);
  }
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'private, no-store');
  }
}

export function isHtmlResponse(response: Response): boolean {
  const ct = response.headers.get('Content-Type');
  if (!ct) return false;
  return ct.toLowerCase().startsWith('text/html');
}
