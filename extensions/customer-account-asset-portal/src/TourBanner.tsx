/**
 * First-login tour for buyers (Phase 1J §7).
 *
 * Shows once per (shop, customer) — KV-backed dismissal on the Worker, so a
 * cleared browser doesn't re-show. Lists Day-1 features (already shipped) and
 * Day-2 teasers (per DECISIONS #13 ordering) so the buyer knows what's
 * coming.
 *
 * Migrated to the 2026.4 Preact + web-component surface — same behaviour as
 * the React original.
 */

import { useEffect, useState } from 'preact/hooks';
import { useApi } from '@shopify/ui-extensions/customer-account/preact';
import { dismissTour, fetchTourStatus, type TourStatusResponse } from './api';

interface Props {
  workerBaseUrl: string;
}

export default function TourBanner({ workerBaseUrl }: Props) {
  const api = useApi<'customer-account.page.render'>();
  const [status, setStatus] = useState<TourStatusResponse | null>(null);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    if (!workerBaseUrl) return;
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
    <s-banner tone="info" heading="Welcome to your wholesale account">
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="tight">
          <s-text emphasis="bold">Available now</s-text>
          {status.day1_features.map(f => (
            <s-text key={f.id}>
              · {f.title} — {f.description}
            </s-text>
          ))}
        </s-stack>
        <s-stack direction="block" gap="tight">
          <s-text emphasis="bold">Coming soon</s-text>
          {status.day2_teasers.map(f => (
            <s-text key={f.id}>
              · {f.title} — {f.description}
            </s-text>
          ))}
        </s-stack>
        <s-stack direction="inline">
          <s-button
            variant="secondary"
            loading={dismissing ? 'true' : undefined}
            onclick={() => void onDismiss()}
          >
            Got it, don't show again
          </s-button>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}
