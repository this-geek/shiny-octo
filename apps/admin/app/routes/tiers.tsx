import { Card, EmptyState, Page } from '@shopify/polaris';

export default function Tiers() {
  return (
    <Page title="Tiers" backAction={{ content: 'Home', url: '/' }}>
      <Card>
        <EmptyState
          heading="Tier pricing"
          action={{ content: 'Back to home', url: '/' }}
          image=""
        >
          <p>
            Tier CRUD, Company → tier mapping, the cart-transform Function and the parity
            harness against the storefront pricing module land in Phase 1D. On Shopify Plus
            shops, tier discounts defer to native Catalogs.
          </p>
        </EmptyState>
      </Card>
    </Page>
  );
}
