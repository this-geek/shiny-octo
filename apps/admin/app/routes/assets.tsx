import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { useLoaderData } from '@remix-run/react';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  ChoiceList,
  EmptyState,
  FormLayout,
  IndexTable,
  InlineStack,
  Layout,
  Modal,
  Page,
  ProgressBar,
  Select,
  Spinner,
  Text,
  TextField,
} from '@shopify/polaris';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type VisibilityMode = 'all_b2b' | 'tiers' | 'companies';
type AssetType = 'image' | 'pdf' | 'video' | 'link';

interface Folder {
  id: number;
  parent_id: number | null;
  name: string;
  visibility_mode: VisibilityMode;
  depth: number;
}

interface Asset {
  id: number;
  folder_id: number | null;
  type: AssetType;
  title: string;
  description: string | null;
  r2_key: string | null;
  external_url: string | null;
  file_size_bytes: number | null;
  mime_type: string | null;
  visibility_mode: VisibilityMode;
  uploaded_at: number;
}

interface VisibilityRule {
  rule_type: 'tier' | 'company';
  rule_target_id: string;
}

interface LoaderData {
  workerBase: string;
  initialIdToken: string | null;
}

declare global {
  interface Window {
    shopify?: { idToken?: () => Promise<string> };
  }
}

export function loader({ request, context }: LoaderFunctionArgs): Response {
  const url = new URL(request.url);
  const env =
    (context as { cloudflare?: { env?: Record<string, string> } }).cloudflare?.env ?? {};
  const workerBase = env.WORKER_URL ?? env.APP_URL ?? '';
  return json<LoaderData>({
    workerBase,
    initialIdToken: url.searchParams.get('id_token'),
  });
}

async function getIdToken(initial: string | null): Promise<string | null> {
  if (typeof window !== 'undefined' && window.shopify?.idToken) {
    try {
      return await window.shopify.idToken();
    } catch {
      return initial;
    }
  }
  return initial;
}

function formatBytes(b: number | null): string {
  if (!b) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface UploadState {
  filename: string;
  total: number;
  uploaded: number;
  error: string | null;
  done: boolean;
}

export default function Assets() {
  const { workerBase, initialIdToken } = useLoaderData<typeof loader>() as LoaderData;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<number | null>(null);

  // Upload state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);

  // Folder modal
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderVisibility, setFolderVisibility] = useState<VisibilityMode>('all_b2b');

  // Link-asset modal
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linkTitle, setLinkTitle] = useState('');
  const [linkUrl, setLinkUrl] = useState('');

  // Visibility modal
  const [visAsset, setVisAsset] = useState<Asset | null>(null);
  const [visMode, setVisMode] = useState<VisibilityMode>('all_b2b');
  const [visRulesText, setVisRulesText] = useState('');

  const fetchAll = useCallback(async (): Promise<void> => {
    if (!workerBase) {
      setError('Worker URL is not configured. Set WORKER_URL on the Pages project.');
      setLoading(false);
      return;
    }
    const token = await getIdToken(initialIdToken);
    if (!token) {
      setError('No session token available. Open the app from the Shopify admin.');
      setLoading(false);
      return;
    }
    try {
      const [fRes, aRes] = await Promise.all([
        fetch(`${workerBase}/admin/asset-folders`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${workerBase}/admin/assets`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (!fRes.ok) throw new Error(`folders HTTP ${fRes.status}`);
      if (!aRes.ok) throw new Error(`assets HTTP ${aRes.status}`);
      const fData = (await fRes.json()) as { folders: Folder[] };
      const aData = (await aRes.json()) as { assets: Asset[] };
      setFolders(fData.folders);
      setAssets(aData.assets);
      setError(null);
    } catch (err) {
      setError(`Could not load: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [workerBase, initialIdToken]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const visibleAssets = useMemo(
    () => assets.filter(a => (selectedFolder === null ? true : a.folder_id === selectedFolder)),
    [assets, selectedFolder],
  );

  const onCreateFolder = useCallback(async (): Promise<void> => {
    const token = await getIdToken(initialIdToken);
    if (!token) {
      setError('No session token available.');
      return;
    }
    try {
      const res = await fetch(`${workerBase}/admin/asset-folders`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parent_id: selectedFolder,
          name: folderName,
          visibility_mode: folderVisibility,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setFolderModalOpen(false);
      setFolderName('');
      setFolderVisibility('all_b2b');
      await fetchAll();
    } catch (err) {
      setError(`Could not create folder: ${String(err)}`);
    }
  }, [workerBase, initialIdToken, selectedFolder, folderName, folderVisibility, fetchAll]);

  const onCreateLinkAsset = useCallback(async (): Promise<void> => {
    const token = await getIdToken(initialIdToken);
    if (!token) {
      setError('No session token available.');
      return;
    }
    try {
      const res = await fetch(`${workerBase}/admin/assets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder_id: selectedFolder,
          type: 'link',
          title: linkTitle,
          external_url: linkUrl,
          visibility_mode: 'all_b2b',
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setLinkModalOpen(false);
      setLinkTitle('');
      setLinkUrl('');
      await fetchAll();
    } catch (err) {
      setError(`Could not create link: ${String(err)}`);
    }
  }, [workerBase, initialIdToken, selectedFolder, linkTitle, linkUrl, fetchAll]);

  const onDeleteAsset = useCallback(
    async (id: number): Promise<void> => {
      if (typeof window !== 'undefined' && !window.confirm('Delete this asset?')) return;
      const token = await getIdToken(initialIdToken);
      if (!token) return;
      try {
        const res = await fetch(`${workerBase}/admin/assets/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await fetchAll();
      } catch (err) {
        setError(`Could not delete: ${String(err)}`);
      }
    },
    [workerBase, initialIdToken, fetchAll],
  );

  const openVisibility = useCallback((a: Asset): void => {
    setVisAsset(a);
    setVisMode(a.visibility_mode);
    setVisRulesText('');
  }, []);

  const onSaveVisibility = useCallback(async (): Promise<void> => {
    if (!visAsset) return;
    const token = await getIdToken(initialIdToken);
    if (!token) return;
    const rules: VisibilityRule[] =
      visMode === 'all_b2b'
        ? []
        : visRulesText
            .split(/[,\n]/)
            .map(s => s.trim())
            .filter(Boolean)
            .map(target => ({
              rule_type: visMode === 'tiers' ? ('tier' as const) : ('company' as const),
              rule_target_id: target,
            }));
    try {
      const res = await fetch(`${workerBase}/admin/assets/${visAsset.id}/visibility`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility_mode: visMode, rules }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setVisAsset(null);
      await fetchAll();
    } catch (err) {
      setError(`Could not save visibility: ${String(err)}`);
    }
  }, [visAsset, visMode, visRulesText, workerBase, initialIdToken, fetchAll]);

  const onFileSelected = useCallback(
    async (file: File): Promise<void> => {
      const token = await getIdToken(initialIdToken);
      if (!token) {
        setError('No session token available.');
        return;
      }
      const state: UploadState = {
        filename: file.name,
        total: file.size,
        uploaded: 0,
        error: null,
        done: false,
      };
      setUploads(prev => [...prev, state]);
      const update = (patch: Partial<UploadState>): void =>
        setUploads(prev => prev.map(u => (u === state ? { ...u, ...patch } : u)));

      try {
        const startRes = await fetch(`${workerBase}/admin/assets/uploads`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            mime_type: file.type || 'application/octet-stream',
            total_size_bytes: file.size,
          }),
        });
        if (!startRes.ok) {
          const j = (await startRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `start HTTP ${startRes.status}`);
        }
        const start = (await startRes.json()) as {
          session_id: string;
          key: string;
          recommended_part_size: number;
        };

        const partSize = Math.max(5 * 1024 * 1024, start.recommended_part_size);
        const parts: { partNumber: number; etag: string }[] = [];
        const totalParts = Math.ceil(file.size / partSize);

        for (let i = 0; i < totalParts; i++) {
          const slice = file.slice(i * partSize, Math.min(file.size, (i + 1) * partSize));
          const partRes = await fetch(
            `${workerBase}/admin/assets/uploads/${start.session_id}/parts/${i + 1}`,
            {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}` },
              body: slice,
            },
          );
          if (!partRes.ok) {
            const j = (await partRes.json().catch(() => ({}))) as { error?: string };
            throw new Error(j.error ?? `part ${i + 1} HTTP ${partRes.status}`);
          }
          const part = (await partRes.json()) as { partNumber: number; etag: string };
          parts.push(part);
          update({ uploaded: Math.min(file.size, (i + 1) * partSize) });
        }

        const completeRes = await fetch(
          `${workerBase}/admin/assets/uploads/${start.session_id}/complete`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ parts }),
          },
        );
        if (!completeRes.ok) {
          const j = (await completeRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `complete HTTP ${completeRes.status}`);
        }
        const completed = (await completeRes.json()) as {
          key: string;
          mime_type: string;
          total_size_bytes: number;
        };

        const type = inferAssetTypeClient(completed.mime_type);
        if (!type || type === 'link') {
          throw new Error(`unsupported mime ${completed.mime_type}`);
        }
        const createRes = await fetch(`${workerBase}/admin/assets`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folder_id: selectedFolder,
            type,
            title: file.name,
            r2_key: completed.key,
            mime_type: completed.mime_type,
            file_size_bytes: completed.total_size_bytes,
            visibility_mode: 'all_b2b',
          }),
        });
        if (!createRes.ok) {
          const j = (await createRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `create HTTP ${createRes.status}`);
        }
        const created = (await createRes.json()) as { asset: { id: number } };

        // Move R2 object to canonical key
        const finRes = await fetch(
          `${workerBase}/admin/assets/${created.asset.id}/finalise-upload`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (!finRes.ok) {
          const j = (await finRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `finalise HTTP ${finRes.status}`);
        }

        update({ done: true, uploaded: file.size });
        await fetchAll();
      } catch (err) {
        update({ error: String(err) });
      }
    },
    [workerBase, initialIdToken, selectedFolder, fetchAll],
  );

  const folderOptions = useMemo(
    () => [
      { label: 'All folders', value: '' },
      ...folders.map(f => ({
        label: `${'  '.repeat(f.depth)}${f.name}`,
        value: String(f.id),
      })),
    ],
    [folders],
  );

  if (loading) {
    return (
      <Page title="Asset library">
        <InlineStack align="center" gap="200">
          <Spinner accessibilityLabel="Loading" size="small" />
          <Text as="span">Loading assets…</Text>
        </InlineStack>
      </Page>
    );
  }

  return (
    <Page
      title="Asset library"
      backAction={{ content: 'Home', url: '/' }}
      primaryAction={{
        content: 'Upload file',
        onAction: () => fileInputRef.current?.click(),
      }}
      secondaryActions={[
        { content: 'New folder', onAction: () => setFolderModalOpen(true) },
        { content: 'Add link', onAction: () => setLinkModalOpen(true) },
      ]}
    >
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) void onFileSelected(file);
          e.target.value = '';
        }}
      />
      <Layout>
        {error ? (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Select
                label="Folder"
                options={folderOptions}
                value={selectedFolder === null ? '' : String(selectedFolder)}
                onChange={v => setSelectedFolder(v === '' ? null : Number(v))}
              />
              <Text as="p" tone="subdued" variant="bodySm">
                Folders nest up to 3 levels. Each folder also carries a default
                visibility used as a hint in the buyer view; the asset's own
                visibility is what gates downloads.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {uploads.length > 0 ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Uploads
                </Text>
                {uploads.map((u, i) => (
                  <BlockStack key={i} gap="100">
                    <InlineStack gap="200" align="space-between">
                      <Text as="span">{u.filename}</Text>
                      <Text as="span" tone={u.error ? 'critical' : 'subdued'}>
                        {u.error
                          ? u.error
                          : u.done
                            ? 'Done'
                            : `${Math.round((u.uploaded / Math.max(u.total, 1)) * 100)}%`}
                      </Text>
                    </InlineStack>
                    <ProgressBar
                      progress={Math.round((u.uploaded / Math.max(u.total, 1)) * 100)}
                      size="small"
                    />
                  </BlockStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            {visibleAssets.length === 0 ? (
              <EmptyState
                heading="No assets in this folder yet"
                action={{
                  content: 'Upload your first file',
                  onAction: () => fileInputRef.current?.click(),
                }}
                image=""
              >
                <p>
                  Drag-and-drop and bulk operations land in a follow-up. For now,
                  upload via the button or paste a Dropbox / Drive link.
                </p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: 'asset', plural: 'assets' }}
                itemCount={visibleAssets.length}
                selectable={false}
                headings={[
                  { title: 'Title' },
                  { title: 'Type' },
                  { title: 'Size' },
                  { title: 'Visibility' },
                  { title: '' },
                ]}
              >
                {visibleAssets.map((a, idx) => (
                  <IndexTable.Row id={String(a.id)} key={a.id} position={idx}>
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="medium">
                        {a.title}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{a.type}</IndexTable.Cell>
                    <IndexTable.Cell>{formatBytes(a.file_size_bytes)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge
                        tone={a.visibility_mode === 'all_b2b' ? 'success' : 'attention'}
                      >
                        {a.visibility_mode.replace('_', ' ')}
                      </Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        <Button variant="plain" onClick={() => openVisibility(a)}>
                          Visibility
                        </Button>
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => void onDeleteAsset(a.id)}
                        >
                          Delete
                        </Button>
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={folderModalOpen}
        onClose={() => setFolderModalOpen(false)}
        title="New folder"
        primaryAction={{ content: 'Create', onAction: () => void onCreateFolder() }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setFolderModalOpen(false) }]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField
              label="Name"
              value={folderName}
              onChange={setFolderName}
              autoComplete="off"
            />
            <ChoiceList
              title="Default visibility"
              choices={[
                { label: 'All B2B buyers', value: 'all_b2b' },
                { label: 'Selected tiers', value: 'tiers' },
                { label: 'Selected companies', value: 'companies' },
              ]}
              selected={[folderVisibility]}
              onChange={v => setFolderVisibility((v[0] ?? 'all_b2b') as VisibilityMode)}
            />
          </FormLayout>
        </Modal.Section>
      </Modal>

      <Modal
        open={linkModalOpen}
        onClose={() => setLinkModalOpen(false)}
        title="Add a link asset"
        primaryAction={{ content: 'Add', onAction: () => void onCreateLinkAsset() }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setLinkModalOpen(false) }]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField
              label="Title"
              value={linkTitle}
              onChange={setLinkTitle}
              autoComplete="off"
            />
            <TextField
              label="URL"
              value={linkUrl}
              onChange={setLinkUrl}
              type="url"
              autoComplete="off"
              helpText="Buyer clicks bounce them to this URL — handy for Dropbox, Drive, Frame.io."
            />
          </FormLayout>
        </Modal.Section>
      </Modal>

      <Modal
        open={visAsset !== null}
        onClose={() => setVisAsset(null)}
        title="Visibility"
        primaryAction={{ content: 'Save', onAction: () => void onSaveVisibility() }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setVisAsset(null) }]}
      >
        <Modal.Section>
          <FormLayout>
            <ChoiceList
              title="Who can see this asset"
              choices={[
                { label: 'All approved B2B buyers', value: 'all_b2b' },
                { label: 'Buyers in specific tiers', value: 'tiers' },
                { label: 'Specific companies', value: 'companies' },
              ]}
              selected={[visMode]}
              onChange={v => setVisMode((v[0] ?? 'all_b2b') as VisibilityMode)}
            />
            {visMode !== 'all_b2b' ? (
              <TextField
                label={
                  visMode === 'tiers'
                    ? 'Tier IDs (comma-separated)'
                    : 'Company GIDs (comma-separated)'
                }
                value={visRulesText}
                onChange={setVisRulesText}
                multiline={3}
                autoComplete="off"
                helpText={
                  visMode === 'tiers'
                    ? 'Numeric tier IDs from the Tiers page.'
                    : 'gid://shopify/Company/123 — one per line or comma-separated.'
                }
              />
            ) : null}
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

function inferAssetTypeClient(mime: string): AssetType | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  return null;
}
