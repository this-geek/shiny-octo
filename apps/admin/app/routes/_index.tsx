import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { useLoaderData, useFetcher } from '@remix-run/react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
} from '@shopify/polaris';

interface ShopStatus {
  is_plus: boolean;
  plus_banner_dismissed: boolean;
  shop_domain: string;
}

interface OnboardingSummary {
  status: 'pending' | 'completed' | 'dismissed';
  current_step: string;
  done_count: number;
  total_steps: number;
}

interface LoaderData {
  status: ShopStatus | null;
  workerBase: string;
  idToken: string | null;
  onboarding: OnboardingSummary | null;
  error?: string;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<Response> {
  const url = new URL(request.url);
  const idToken = url.searchParams.get('id_token');

  const env = (context as { cloudflare?: { env?: Record<string, string> } }).cloudflare?.env ?? {};
  const workerBase = env.WORKER_URL ?? env.APP_URL ?? '';

  if (!idToken || !workerBase) {
    return json<LoaderData>({ status: null, workerBase, idToken, onboarding: null, error: 'missing id_token' });
  }

  try {
    const [statusRes, onboardingRes] = await Promise.all([
      fetch(`${workerBase}/admin/shop-status`, {
        headers: { Authorization: `Bearer ${idToken}` },
      }),
      fetch(`${workerBase}/admin/onboarding/state`, {
        headers: { Authorization: `Bearer ${idToken}` },
      }),
    ]);
    if (!statusRes.ok) {
      return json<LoaderData>({
        status: null,
        workerBase,
        idToken,
        onboarding: null,
        error: `status ${statusRes.status}`,
      });
    }
    const status = (await statusRes.json()) as ShopStatus;

    let onboarding: OnboardingSummary | null = null;
    if (onboardingRes.ok) {
      const body = (await onboardingRes.json()) as {
        state: { status: 'pending' | 'completed' | 'dismissed'; current_step: string; steps: Record<string, { done: boolean; skipped: boolean }> };
        steps: string[];
        skippable: string[];
      };
      const skippable = new Set(body.skippable);
      const doneCount = body.steps.filter(id => {
        const s = body.state.steps[id];
        return s && (s.done || (s.skipped && skippable.has(id)));
      }).length;
      onboarding = {
        status: body.state.status,
        current_step: body.state.current_step,
        done_count: doneCount,
        total_steps: body.steps.length,
      };
    }

    return json<LoaderData>({ status, workerBase, idToken, onboarding });
  } catch (err) {
    return json<LoaderData>({ status: null, workerBase, idToken, onboarding: null, error: String(err) });
  }
}

export default function Index() {
  const { status, idToken, onboarding } = useLoaderData<typeof loader>() as LoaderData;
  const dismissFetcher = useFetcher();

  const dismissed =
    dismissFetcher.state !== 'idle' || dismissFetcher.data
      ? true
      : (status?.plus_banner_dismissed ?? false);

  const showBanner = status?.is_plus === true && !dismissed;

  const onDismiss = (): void => {
    dismissFetcher.submit(
      { idToken: idToken ?? '' },
      { method: 'post', action: '/dismiss-plus-banner' },
    );
  };

  return (
    <Page title="B2B Companion">
      <Layout>
        {showBanner ? (
          <Layout.Section>
            <Banner
              tone="info"
              title="Tier discount Function is disabled on Plus"
              onDismiss={onDismiss}
            >
              <p>
                Your shop is on Shopify Plus, which supports unlimited Catalogs assigned directly
                to Company Locations. B2B Companion defers to Plus for tier discounting and
                disables its cart-transform Function to avoid double-discounting. All other
                features (registration, assets, minimums, shipping rules, sales rep portal)
                remain active.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        {onboarding?.status === 'pending' ? (
          <Layout.Section>
            <Banner
              tone="info"
              title={`Finish setting up B2B Companion — ${onboarding.done_count} of ${onboarding.total_steps} steps done`}
              action={{ content: 'Continue setup', url: '/onboarding' }}
            >
              <p>
                The setup wizard walks you through detecting your existing B2B setup, configuring
                tiers, building the registration form, creating a test buyer, and a go-live
                checklist. You can dismiss it from the wizard at any time.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Get started</Text>
              <Text as="p" tone="subdued">
                The pilot surfaces these live areas. Other sections fill in as later phases land.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="400">
            <NavCard
              title="Tiers"
              badge="Live"
              url="/tiers"
              cta="Open tiers"
              description="Create discount tiers, set order minimums, and configure per-tier shipping rules. Map a Shopify Company to a tier from the Companies page."
            />
            <NavCard
              title="Companies"
              badge="Live"
              url="/companies"
              cta="Open companies"
              description="Map Shopify Companies to tiers. Every mapping change mirrors b2b.tier_id onto the Company metafield for the cart-transform Function."
            />
            <NavCard
              title="Asset library"
              badge="Live"
              url="/assets"
              cta="Open assets"
              description="Upload catalogs, price lists, and product imagery. Set visibility per tier or per company; buyers download via signed proxy routes that re-check visibility on every request."
            />
            <NavCard
              title="Applications"
              badge="Live"
              url="/applications"
              cta="Open queue"
              description="Approve, reject, or request more info on incoming wholesale applications. Approve creates the Shopify Company idempotently and sends a templated email."
            />
            <NavCard
              title="Settings"
              badge="Live"
              url="/settings"
              cta="Open settings"
              description="Brand colours, application form builder, and email templates."
            />
            <NavCard
              title="Onboarding"
              badge="Live"
              url="/onboarding"
              cta={onboarding?.status === 'pending' ? 'Continue' : 'Open wizard'}
              description={
                onboarding?.status === 'completed'
                  ? 'Setup complete. Reopen to revisit any step.'
                  : onboarding?.status === 'dismissed'
                    ? 'Dismissed. Reopen to resume any step.'
                    : `Six-step setup wizard — ${onboarding?.done_count ?? 0} of ${onboarding?.total_steps ?? 6} done.`
              }
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function NavCard({
  title,
  badge,
  description,
  url,
  cta,
}: {
  title: string;
  badge: 'Live' | 'Stub';
  description: string;
  url: string;
  cta: string;
}): JSX.Element {
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h3" variant="headingSm">{title}</Text>
            <Badge tone={badge === 'Live' ? 'success' : undefined}>{badge}</Badge>
          </InlineStack>
          <Button url={url} variant={badge === 'Live' ? 'primary' : undefined}>{cta}</Button>
        </InlineStack>
        <Box>
          <Text as="p" tone="subdued">{description}</Text>
        </Box>
      </BlockStack>
    </Card>
  );
}
