import { Card, EmptyState, Page } from '@shopify/polaris';

export default function Assets() {
  return (
    <Page title="Asset library" backAction={{ content: 'Home', url: '/' }}>
      <Card>
        <EmptyState
          heading="Dealer asset portal"
          action={{ content: 'Back to home', url: '/' }}
          image=""
        >
          <p>
            The drag-drop chunked uploader, three-level folder CRUD, visibility rules
            (all-B2B / tiers / companies), Cloudflare Images variants, signed-URL delivery
            and the buyer-side browse/search/download experience all land in Phase 1C.
          </p>
        </EmptyState>
      </Card>
    </Page>
  );
}
