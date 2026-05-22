/**
 * Root layout for the B2B Companion embedded admin app.
 *
 * TODO Phase 1: Wire up App Bridge authentication:
 *   1. Read the session token from URL search params (?session=...)
 *   2. Pass it to <Provider apiKey={...} /> for App Bridge initialisation
 *   3. Set up token refresh via app.sessionToken.get() on each loader/action
 *   4. Add CSRF protection for mutations using the session token
 */

import { Links, Meta, Outlet, Scripts, ScrollRestoration } from '@remix-run/react';
import { AppProvider as PolarisAppProvider } from '@shopify/polaris';
import '@shopify/polaris/build/esm/styles.css';

// TODO Phase 1: Replace with real API key from environment / loader
const SHOPIFY_API_KEY = typeof process !== 'undefined' ? (process.env.SHOPIFY_API_KEY ?? '') : '';

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {/*
          TODO Phase 1: Wrap with App Bridge <Provider> once authentication is wired:
          import { Provider as AppBridgeProvider } from '@shopify/app-bridge-react';
          <AppBridgeProvider config={{ apiKey: SHOPIFY_API_KEY, host: ... }}>
            ...
          </AppBridgeProvider>
        */}
        <PolarisAppProvider i18n={{}}>
          <Outlet />
        </PolarisAppProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
