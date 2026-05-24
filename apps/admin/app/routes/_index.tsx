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

interface LoaderData {
  status: ShopStatus | null;
  workerBase: string;
  idToken: string | null;
  error?: string;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<Response> {
  const url = new URL(request.url);
  const idToken = url.searchParams.get('id_token');

  const env = (context as { cloudflare?: { env?: Record<string, string> } }).cloudflare?.env ?? {};
  const workerBase = env.WORKER_URL ?? env.APP_URL ?? '';

  if (!idToken || !workerBase) {
    return json<LoaderData>({ status: null, workerBase, idToken, error: 'missing id_token' });
  }

  try {
    const res = await fetch(`${workerBase}/admin/shop-status`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) {
      return json<LoaderData>({ status: null, workerBase, idToken, error: `status ${res.status}` });
    }
    const status = (await res.json()) as ShopStatus;
    return json<LoaderData>({ status, workerBase, idToken });
  } catch (err) {
    return json<LoaderData>({ status: null, workerBase, idToken, error: String(err) });
  }
}

export default function Index() {
  const { status, workerBase, idToken } = useLoaderData<typeof loader>() as LoaderData;
  const dismissFetcher = useFetcher();

  const dismissed =
    dismissFetcher.state !== 'idle' || dismissFetcher.data
      ? true
      : (status?.plus_banner_dismissed ?? false);

  const showBanner = status?.is_plus === true && !dismissed;

  const onDismiss = (): void => {
    dismissFetcher.submit(
      { workerBase, idToken: idToken ?? '' },
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

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Get started</Text>
              <Text as="p" tone="subdued">
                The pilot surfaces three live areas. Other sections are stubs until the matching
                phase lands.
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
              badge="Stub"
              url="/onboarding"
              cta="View"
              description="Seven-step setup wizard lands in Phase 1I."
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
