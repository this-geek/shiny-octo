/**
 * Catch-all JSX intrinsics for Shopify's web-component UI primitives.
 *
 * In API version 2026-04 Shopify shipped Customer Account UI extensions on
 * a Preact + web-components stack (`<s-page>`, `<s-stack>`, `<s-button>`,
 * etc.). Each component's .d.ts inside @shopify/ui-extensions augments
 * `preact.createElement.JSX.IntrinsicElements`, but the package's
 * typesVersions doesn't expose the customer-account/components subpath, so
 * those augmentations aren't pulled in unless we cherry-pick individual
 * files. This declaration provides a permissive `s-${string}` catch-all so
 * the bundler and tsc both accept the markup without a forest of relative
 * triple-slash references; component prop validation is delegated to
 * runtime + Shopify's editor.
 */

import 'preact';

declare module 'preact' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace createElement.JSX {
    interface IntrinsicElements {
      [tag: `s-${string}`]: {
        // Use Record<string, unknown> with a children opt-in so the JSX
        // typechecker stays out of the way while we wait for Shopify to
        // publish per-component type subpath access.
        [key: string]: unknown;
        children?: preact.ComponentChildren;
      };
    }
  }
}
