import { useEffect, useState } from 'react';
import {
  Banner,
  BlockStack,
  Button,
  InlineStack,
  Text,
  useApi,
} from '@shopify/ui-extensions-react/customer-account';
import { dismissTour, fetchTourStatus, type TourStatusResponse } from './api';

interface Props {
  workerBaseUrl: string;
}

/**
 * First-login tour for buyers (Phase 1J §7).
 *
 * Shows once per (shop, customer) — KV-backed dismissal on the Worker, so a
 * cleared browser doesn't re-show. Lists Day-1 features (already shipped) and
 * Day-2 teasers (per DECISIONS #13 ordering) so the buyer knows what's
 * coming.
 */
export default function TourBanner({ workerBaseUrl }: Props): JSX.Element | null {
  const api = useApi();
  const [status, setStatus] = useState<TourStatusResponse | null>(null);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await api.sessionToken.get();
        const s = await fetchTourStatus(workerBaseUrl, token);
        if (!cancelled) setStatus(s);
      } catch {
        // Tour is non-essential UI; swallow errors.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, workerBaseUrl]);

  async function onDismiss(): Promise<void> {
    setDismissing(true);
    try {
      const token = await api.sessionToken.get();
      await dismissTour(workerBaseUrl, token);
      setStatus(null);
    } catch {
      // No-op; the banner will retry next page load.
    } finally {
      setDismissing(false);
    }
  }

  if (!status || !status.show_tour) return null;

  return (
    <Banner status="info" title="Welcome to your wholesale account">
      <BlockStack spacing="base">
        <BlockStack spacing="tight">
          <Text emphasis="bold">Available now</Text>
          {status.day1_features.map(f => (
            <Text key={f.id}>
              · {f.title} — {f.description}
            </Text>
          ))}
        </BlockStack>
        <BlockStack spacing="tight">
          <Text emphasis="bold">Coming soon</Text>
          {status.day2_teasers.map(f => (
            <Text key={f.id} appearance="subdued">
              · {f.title} — {f.description}
            </Text>
          ))}
        </BlockStack>
        <InlineStack>
          <Button kind="secondary" onPress={onDismiss} loading={dismissing}>
            Got it, don't show again
          </Button>
        </InlineStack>
      </BlockStack>
    </Banner>
  );
}
