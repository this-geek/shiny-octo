import { Card, EmptyState, Page } from '@shopify/polaris';

export default function Applications() {
  return (
    <Page title="Applications" backAction={{ content: 'Home', url: '/' }}>
      <Card>
        <EmptyState
          heading="Wholesale applications queue"
          action={{ content: 'Configure the form', url: '/settings' }}
          image=""
        >
          <p>
            The approval queue (list, filters, document previews, idempotent approve →
            companyCreate, reject + request-more-info templates, magic-link welcome) lands
            in Phase 1E.
          </p>
        </EmptyState>
      </Card>
    </Page>
  );
}
