/**
 * Customer Account UI extension — dealer portal link block.
 *
 * Single-target block (customer-account.order-index.block.render) that
 * surfaces a link to the Worker-hosted dealer portal at
 *   <shop>/apps/<subpath>/portal
 * served via Shopify App Proxy.
 *
 * The previous full-page extension hit the validator's "page.render
 * cannot be combined with any other targets" rule. This block sidesteps
 * the constraint by having exactly one target and offloads the portal UX
 * to the Worker.
 *
 * Merchant configures `portal_url` once (see shopify.extension.toml);
 * heading + cta_label are optional with sensible defaults.
 */

import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useApi } from '@shopify/ui-extensions/customer-account/preact';

interface BlockSettings {
  portal_url?: string;
  heading?: string;
  cta_label?: string;
}

export default function extension() {
  render(<PortalLinkBlock />, document.body);
}

function PortalLinkBlock() {
  const api = useApi<'customer-account.order-index.block.render'>();
  const settings = (api.settings.value as BlockSettings | undefined) ?? {};

  const portalUrl = (settings.portal_url ?? '').trim();
  if (!portalUrl) return null;

  const heading = (settings.heading ?? '').trim() || 'Dealer portal';
  const ctaLabel = (settings.cta_label ?? '').trim() || 'Open dealer portal';

  return (
    <s-section heading={heading}>
      <s-paragraph>
        Browse line sheets, price lists, and product photography. Wholesale
        pricing, your tier, and your company profile are also available.
      </s-paragraph>
      <s-link href={portalUrl} target="_self">
        {ctaLabel}
      </s-link>
    </s-section>
  );
}
