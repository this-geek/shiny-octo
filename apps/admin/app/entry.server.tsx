import type { AppLoadContext, EntryContext } from '@remix-run/cloudflare';
import { RemixServer } from '@remix-run/react';
import { isbot } from 'isbot';
import { renderToReadableStream } from 'react-dom/server';

const SHOPIFY_FRAME_ANCESTORS = 'https://*.myshopify.com https://admin.shopify.com';

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
  _loadContext: AppLoadContext,
): Promise<Response> {
  const controller = new AbortController();
  request.signal.addEventListener('abort', () => controller.abort());

  let status = responseStatusCode;
  const body = await renderToReadableStream(
    <RemixServer context={remixContext} url={request.url} abortDelay={5000} />,
    {
      signal: controller.signal,
      onError(error: unknown) {
        if (!controller.signal.aborted) {
          console.error(error);
        }
        status = 500;
      },
    },
  );

  if (isbot(request.headers.get('user-agent') ?? '')) {
    await body.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html');
  // X-Frame-Options would block the Shopify admin iframe; rely on CSP frame-ancestors instead.
  responseHeaders.delete('X-Frame-Options');
  responseHeaders.set(
    'Content-Security-Policy',
    `frame-ancestors ${SHOPIFY_FRAME_ANCESTORS}`,
  );

  return new Response(body, {
    headers: responseHeaders,
    status,
  });
}
