import { useEffect, useMemo, useState } from 'react';
import {
  reactExtension,
  useApi,
  Page,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  Button,
  Text,
  Banner,
  Spinner,
  Heading,
} from '@shopify/ui-extensions-react/customer-account';
import { fetchAssets, downloadAsset, type AssetItem } from './api';
import CompanyProfileView from './CompanyProfileView';
import TourBanner from './TourBanner';

function bytesFmt(b: number | null): string {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type View = 'assets' | 'profile';

function AssetPortal() {
  const api = useApi();
  const workerBaseUrl = (api as { settings?: { current?: { worker_base_url?: string } } })
    ?.settings?.current?.worker_base_url
    ?? '';

  const [view, setView] = useState<View>('assets');
  const [assets, setAssets] = useState<AssetItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [type, setType] = useState<'all' | 'file' | 'image' | 'video' | 'link'>('all');
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  useEffect(() => {
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

  async function onDownload(asset: AssetItem) {
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
  }

  const header = (
    <BlockStack spacing="base">
      <TourBanner workerBaseUrl={workerBaseUrl} />
      <InlineStack spacing="tight">
        <Button
          kind={view === 'assets' ? 'primary' : 'secondary'}
          onPress={() => setView('assets')}
        >
          Assets
        </Button>
        <Button
          kind={view === 'profile' ? 'primary' : 'secondary'}
          onPress={() => setView('profile')}
        >
          Company profile
        </Button>
      </InlineStack>
    </BlockStack>
  );

  if (view === 'profile') {
    return (
      <Page title="Wholesale account">
        <BlockStack spacing="loose">
          {header}
          <CompanyProfileView workerBaseUrl={workerBaseUrl} />
        </BlockStack>
      </Page>
    );
  }

  if (error) {
    return (
      <Page title="Wholesale account">
        <BlockStack spacing="loose">
          {header}
          <Banner status="critical">{error}</Banner>
        </BlockStack>
      </Page>
    );
  }
  if (assets === null) {
    return (
      <Page title="Wholesale account">
        <BlockStack spacing="loose">
          {header}
          <Spinner />
        </BlockStack>
      </Page>
    );
  }
  if (assets.length === 0) {
    return (
      <Page title="Wholesale account">
        <BlockStack spacing="loose">
          {header}
          <Text>No assets available for your account yet.</Text>
        </BlockStack>
      </Page>
    );
  }

  return (
    <Page title="Wholesale account">
      <BlockStack spacing="loose">
        {header}
        <InlineStack spacing="base">
          <TextField label="Search" value={filter} onChange={setFilter} />
          <Select
            label="Type"
            value={type}
            onChange={(v: string) => setType(v as typeof type)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'file', label: 'Files' },
              { value: 'image', label: 'Images' },
              { value: 'video', label: 'Videos' },
              { value: 'link', label: 'Links' },
            ]}
          />
        </InlineStack>

        {filtered.length === 0 ? (
          <Text appearance="subdued">No assets match.</Text>
        ) : (
          filtered.map(a => (
            <BlockStack key={a.id} spacing="tight">
              <Heading level={3}>{a.title}</Heading>
              {a.description && <Text appearance="subdued">{a.description}</Text>}
              <Text appearance="subdued">
                {[a.type, bytesFmt(a.file_size_bytes)].filter(Boolean).join(' · ')}
              </Text>
              <Button
                kind="primary"
                onPress={() => onDownload(a)}
                loading={downloadingId === a.id}
              >
                Download
              </Button>
            </BlockStack>
          ))
        )}
      </BlockStack>
    </Page>
  );
}

export default reactExtension('customer-account.page.render', () => <AssetPortal />);
