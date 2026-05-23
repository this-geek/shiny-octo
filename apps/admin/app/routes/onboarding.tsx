import { Card, EmptyState, Page } from '@shopify/polaris';

export default function Onboarding() {
  return (
    <Page title="Onboarding" backAction={{ content: 'Home', url: '/' }}>
      <Card>
        <EmptyState
          heading="Set up B2B Companion"
          action={{ content: 'Back to home', url: '/' }}
          image=""
        >
          <p>
            The seven-step wizard (detect existing B2B setup, migrate wholesale customers,
            configure tiers, build the registration form, bootstrap the asset library, create
            a test customer, go-live checklist) lands in Phase 1I.
          </p>
        </EmptyState>
      </Card>
    </Page>
  );
}
