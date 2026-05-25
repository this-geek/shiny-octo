/**
 * Order-index block that surfaces a link to the dealer asset portal so
 * buyers can find it without hunting through the customer-account nav.
 *
 * Same Preact + web-component pattern as AssetPortalPage.tsx; mounted by
 * Shopify's runtime via the `extension()` default export.
 */

import '@shopify/ui-extensions/preact';
import { render } from 'preact';

export default function extension() {
  render(<AssetPortalLink />, document.body);
}

function AssetPortalLink() {
  return (
    <s-stack direction="block" gap="tight">
      <s-text emphasis="bold">Dealer resources</s-text>
      <s-link to="extension:b2b-asset-portal/">Browse dealer assets</s-link>
    </s-stack>
  );
}
