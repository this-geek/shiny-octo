import { Card, EmptyState, Page } from '@shopify/polaris';

export default function Analytics() {
  return (
    <Page title="Analytics" backAction={{ content: 'Home', url: '/' }}>
      <Card>
        <EmptyState
          heading="Analytics will arrive after Day 1"
          action={{ content: 'Back to home', url: '/' }}
          image=""
        >
          <p>
            Day-1 ships without analytics by design — the pilot prioritises shipping the
            wedge over instrumentation. Asset-download leaderboards, tier-performance
            breakdowns and approval funnels are sequenced in Phase 3 per DECISIONS #13.
          </p>
        </EmptyState>
      </Card>
    </Page>
  );
}
