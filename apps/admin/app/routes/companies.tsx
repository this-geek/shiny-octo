import { Card, EmptyState, Page } from '@shopify/polaris';

export default function Companies() {
  return (
    <Page title="Companies" backAction={{ content: 'Home', url: '/' }}>
      <Card>
        <EmptyState
          heading="Companies are managed in Shopify"
          action={{
            content: 'Open in Shopify admin',
            url: 'shopify://admin/companies',
            external: true,
          }}
          image=""
        >
          <p>
            Companies, Locations, Catalogs and payment terms remain Shopify&apos;s native
            objects. This page will surface the B2B Companion overlay (tier mapping, credit
            limit, asset access) in Phase 1D.
          </p>
        </EmptyState>
      </Card>
    </Page>
  );
}
