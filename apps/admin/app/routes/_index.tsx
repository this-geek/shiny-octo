import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { useLoaderData, useFetcher } from '@remix-run/react';
import { Banner, Page, EmptyState, Card } from '@shopify/polaris';

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
      {showBanner ? (
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
      ) : null}

      <Card>
        <EmptyState
          heading="Welcome to B2B Companion"
          action={{ content: 'View setup steps', url: '/onboarding' }}
          image=""
        >
          <p>Configure tiers, applications, and the dealer asset library.</p>
        </EmptyState>
      </Card>
    </Page>
  );
}
