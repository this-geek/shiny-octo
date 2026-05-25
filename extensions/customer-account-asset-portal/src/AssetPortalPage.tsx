/**
 * Customer Account UI extension — dealer portal (Phase 1H+, Phase 1J UX).
 *
 * Built on Shopify's 2026.4 Preact + web-component runtime. The host
 * mounts each target's `extension()` export as the entry point; we render
 * a Preact tree of `<s-*>` web components into document.body, which the
 * runtime then bridges to the customer account surface.
 *
 * UX:
 *   - TourBanner at top — first-login feature tour (KV-backed dismissal)
 *   - Tabs: Assets · Company profile
 *   - Assets tab: searchable, type-filterable list with stream-through download
 *   - Profile tab: Day-1 read-only company / tier / locations / team
 *
 * Auth: Customer Account session token (api.sessionToken.get()), passed as
 * a Bearer header to the Worker's /customer-account/* routes. The Worker
 * re-checks visibility + bandwidth on every list/download.
 *
 * Worker base URL comes from the merchant-configured `worker_base_url`
 * extension setting (declared in shopify.extension.toml).
 */

import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useApi } from '@shopify/ui-extensions/customer-account/preact';
import { downloadAsset, fetchAssets, type AssetItem } from './api';
import CompanyProfileView from './CompanyProfileView';
import TourBanner from './TourBanner';

export default function extension() {
  render(<AssetPortal />, document.body);
}

function bytesFmt(b: number | null): string {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type View = 'assets' | 'profile';

function AssetPortal() {
  const api = useApi<'customer-account.page.render'>();
  const settings = api.settings.value as { worker_base_url?: string } | undefined;
  const workerBaseUrl = settings?.worker_base_url ?? '';

  const [view, setView] = useState<View>('assets');
  const [assets, setAssets] = useState<AssetItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [type, setType] = useState<'all' | 'file' | 'image' | 'video' | 'link'>('all');
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  useEffect(() => {
    if (!workerBaseUrl) {
      setError('Worker base URL is not configured. Set it in the extension settings.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await api.sessionToken.get();
        const list = await fetchAssets(workerBaseUrl, token);
        if (!cancelled) setAssets(list);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, workerBaseUrl]);

  const filtered = useMemo(() => {
    if (!assets) return [];
    const term = filter.trim().toLowerCase();
    return assets.filter(a => {
      if (type !== 'all' && a.type !== type) return false;
      if (!term) return true;
      return (a.title + ' ' + (a.description ?? '')).toLowerCase().includes(term);
    });
  }, [assets, filter, type]);

  const onDownload = useCallback(
    async (asset: AssetItem) => {
      setDownloadingId(asset.id);
      setError(null);
      try {
        const token = await api.sessionToken.get();
        const r = await downloadAsset(workerBaseUrl, token, asset.id);
        if (r.kind === 'link') {
          window.open(r.url, '_blank', 'noopener');
        } else {
          const url = URL.createObjectURL(r.blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = r.filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        }
      } catch (e) {
        setError(String((e as Error).message ?? e));
      } finally {
        setDownloadingId(null);
      }
    },
    [api, workerBaseUrl],
  );

  const header = (
    <s-stack direction="block" gap="base">
      <TourBanner workerBaseUrl={workerBaseUrl} />
      <s-stack direction="inline" gap="tight">
        <s-button
          variant={view === 'assets' ? 'primary' : 'secondary'}
          onclick={() => setView('assets')}
        >
          Assets
        </s-button>
        <s-button
          variant={view === 'profile' ? 'primary' : 'secondary'}
          onclick={() => setView('profile')}
        >
          Company profile
        </s-button>
      </s-stack>
    </s-stack>
  );

  if (view === 'profile') {
    return (
      <s-page heading="Wholesale account">
        <s-stack direction="block" gap="loose">
          {header}
          <CompanyProfileView workerBaseUrl={workerBaseUrl} />
        </s-stack>
      </s-page>
    );
  }

  if (error) {
    return (
      <s-page heading="Wholesale account">
        <s-stack direction="block" gap="loose">
          {header}
          <s-banner tone="critical">{error}</s-banner>
        </s-stack>
      </s-page>
    );
  }
  if (assets === null) {
    return (
      <s-page heading="Wholesale account">
        <s-stack direction="block" gap="loose">
          {header}
          <s-spinner accessibilityLabel="Loading assets" />
        </s-stack>
      </s-page>
    );
  }
  if (assets.length === 0) {
    return (
      <s-page heading="Wholesale account">
        <s-stack direction="block" gap="loose">
          {header}
          <s-text>No assets available for your account yet.</s-text>
        </s-stack>
      </s-page>
    );
  }

  return (
    <s-page heading="Wholesale account">
      <s-stack direction="block" gap="loose">
        {header}
        <s-stack direction="inline" gap="base">
          <s-text-field
            label="Search"
            value={filter}
            oninput={(e: Event) => setFilter((e.target as HTMLInputElement).value)}
          />
          <s-select
            label="Type"
            value={type}
            onchange={(e: Event) => setType((e.target as HTMLSelectElement).value as typeof type)}
          >
            <s-option value="all">All</s-option>
            <s-option value="file">Files</s-option>
            <s-option value="image">Images</s-option>
            <s-option value="video">Videos</s-option>
            <s-option value="link">Links</s-option>
          </s-select>
        </s-stack>

        {filtered.length === 0 ? (
          <s-text>No assets match.</s-text>
        ) : (
          filtered.map(a => (
            <s-stack key={a.id} direction="block" gap="tight">
              <s-heading>{a.title}</s-heading>
              {a.description ? <s-text>{a.description}</s-text> : null}
              <s-text>{[a.type, bytesFmt(a.file_size_bytes)].filter(Boolean).join(' · ')}</s-text>
              <s-button
                variant="primary"
                loading={downloadingId === a.id ? 'true' : undefined}
                onclick={() => void onDownload(a)}
              >
                Download
              </s-button>
            </s-stack>
          ))
        )}
      </s-stack>
    </s-page>
  );
}
