import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { useLoaderData } from '@remix-run/react';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Spinner,
  Text,
  TextField,
} from '@shopify/polaris';
import { useCallback, useEffect, useMemo, useState } from 'react';

type Status = 'draft' | 'submitted' | 'approved' | 'rejected' | 'needs_info';

interface ApplicationRow {
  id: number;
  email: string;
  status: Status;
  submitted_at: number | null;
  decided_at: number | null;
  decided_by: string | null;
  decision_notes: string | null;
  created_company_id: string | null;
  created_location_id: string | null;
  shopify_customer_id: string | null;
  created_at: number | null;
  last_autosaved_at: number | null;
}

interface ApplicationDocument {
  name: string;
  r2_key: string;
  size: number;
  mime: string;
}

interface ApplicationDetail extends ApplicationRow {
  form: {
    fields: Record<string, string>;
    email: string;
    countryCode?: string;
    taxId?: string;
    gstNumber?: string;
    companyName?: string;
    documents: ApplicationDocument[];
  };
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

function statusTone(s: Status): 'success' | 'attention' | 'critical' | 'info' | undefined {
  switch (s) {
    case 'submitted':
      return 'attention';
    case 'approved':
      return 'success';
    case 'rejected':
      return 'critical';
    case 'needs_info':
      return 'info';
    default:
      return undefined;
  }
}

function fmtTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString();
}

function bytesFmt(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default function Applications() {
  const { workerBase, initialIdToken } = useLoaderData<typeof loader>() as LoaderData;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ApplicationRow[]>([]);
  const [filter, setFilter] = useState<Status | ''>('submitted');

  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState('');

  const fetchList = useCallback(async (): Promise<void> => {
    if (!workerBase) {
      setError('Worker URL is not configured.');
      setLoading(false);
      return;
    }
    const token = await getIdToken(initialIdToken);
    if (!token) {
      setError('No session token.');
      setLoading(false);
      return;
    }
    try {
      const url = filter
        ? `${workerBase}/admin/applications?status=${filter}`
        : `${workerBase}/admin/applications`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { applications: ApplicationRow[] };
      setRows(data.applications);
      setError(null);
    } catch (err) {
      setError(`Could not load: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [workerBase, initialIdToken, filter]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  const openDetail = useCallback(
    async (row: ApplicationRow): Promise<void> => {
      setDetail(null);
      setNotes(row.decision_notes ?? '');
      setDetailLoading(true);
      const token = await getIdToken(initialIdToken);
      if (!token) return;
      try {
        const res = await fetch(`${workerBase}/admin/applications/${row.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { application: ApplicationDetail };
        setDetail(data.application);
      } catch (err) {
        setError(`Could not load detail: ${String(err)}`);
      } finally {
        setDetailLoading(false);
      }
    },
    [workerBase, initialIdToken],
  );

  const callAction = useCallback(
    async (id: number, action: 'approve' | 'reject' | 'request-info'): Promise<void> => {
      const label =
        action === 'approve' ? 'approve' : action === 'reject' ? 'reject' : 'request more info';
      if (typeof window !== 'undefined' && !window.confirm(`Confirm: ${label}?`)) return;
      const token = await getIdToken(initialIdToken);
      if (!token) return;
      setActionBusy(action);
      try {
        const res = await fetch(`${workerBase}/admin/applications/${id}/${action}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: notes || null }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        setDetail(null);
        await fetchList();
      } catch (err) {
        setError(`Action failed: ${String(err)}`);
      } finally {
        setActionBusy(null);
      }
    },
    [workerBase, initialIdToken, notes, fetchList],
  );

  const downloadDoc = useCallback(
    async (applicationId: number, doc: ApplicationDocument): Promise<void> => {
      const token = await getIdToken(initialIdToken);
      if (!token) return;
      try {
        const url = `${workerBase}/admin/applications/${applicationId}/document?key=${encodeURIComponent(doc.r2_key)}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = doc.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
      } catch (err) {
        setError(`Download failed: ${String(err)}`);
      }
    },
    [workerBase, initialIdToken],
  );

  const filterOptions = useMemo(
    () => [
      { label: 'Submitted', value: 'submitted' },
      { label: 'Needs info', value: 'needs_info' },
      { label: 'Approved', value: 'approved' },
      { label: 'Rejected', value: 'rejected' },
      { label: 'Drafts', value: 'draft' },
      { label: 'All', value: '' },
    ],
    [],
  );

  if (loading) {
    return (
      <Page title="Applications">
        <InlineStack align="center" gap="200">
          <Spinner accessibilityLabel="Loading" size="small" />
          <Text as="span">Loading…</Text>
        </InlineStack>
      </Page>
    );
  }

  return (
    <Page title="Applications" backAction={{ content: 'Home', url: '/' }}>
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
              <InlineStack gap="200" align="space-between" blockAlign="center">
                <Text as="h2" variant="headingSm">
                  Approval queue
                </Text>
                <Select
                  label=""
                  labelHidden
                  options={filterOptions}
                  value={filter}
                  onChange={v => setFilter(v as Status | '')}
                />
              </InlineStack>

              {rows.length === 0 ? (
                <EmptyState
                  heading="No applications in this view"
                  action={{ content: 'Configure form', url: '/settings' }}
                  image=""
                >
                  <p>
                    Buyers apply through the wholesale form embedded on your
                    storefront. The form template, fields, and emails are configured
                    in Settings.
                  </p>
                </EmptyState>
              ) : (
                <IndexTable
                  resourceName={{ singular: 'application', plural: 'applications' }}
                  itemCount={rows.length}
                  selectable={false}
                  headings={[
                    { title: 'Email' },
                    { title: 'Status' },
                    { title: 'Submitted' },
                    { title: 'Decided' },
                    { title: '' },
                  ]}
                >
                  {rows.map((r, idx) => (
                    <IndexTable.Row id={String(r.id)} key={r.id} position={idx}>
                      <IndexTable.Cell>
                        <Text as="span" fontWeight="medium">
                          {r.email}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{fmtTime(r.submitted_at)}</IndexTable.Cell>
                      <IndexTable.Cell>{fmtTime(r.decided_at)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <Button variant="plain" onClick={() => void openDetail(r)}>
                          Open
                        </Button>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={detail !== null || detailLoading}
        onClose={() => {
          setDetail(null);
          setActionBusy(null);
        }}
        title={detail ? `Application from ${detail.email}` : 'Loading…'}
        primaryAction={
          detail && (detail.status === 'submitted' || detail.status === 'needs_info')
            ? {
                content: 'Approve',
                onAction: () => void callAction(detail.id, 'approve'),
                loading: actionBusy === 'approve',
              }
            : undefined
        }
        secondaryActions={
          detail
            ? [
                ...(detail.status === 'submitted' || detail.status === 'needs_info'
                  ? [
                      {
                        content: 'Request more info',
                        onAction: () => void callAction(detail.id, 'request-info'),
                        loading: actionBusy === 'request-info',
                      },
                      {
                        content: 'Reject',
                        destructive: true,
                        onAction: () => void callAction(detail.id, 'reject'),
                        loading: actionBusy === 'reject',
                      },
                    ]
                  : []),
                { content: 'Close', onAction: () => setDetail(null) },
              ]
            : [{ content: 'Close', onAction: () => setDetail(null) }]
        }
      >
        <Modal.Section>
          {detailLoading || !detail ? (
            <InlineStack align="center" gap="200">
              <Spinner accessibilityLabel="Loading" size="small" />
              <Text as="span">Loading…</Text>
            </InlineStack>
          ) : (
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="p" tone="subdued">
                  Status:{' '}
                  <Badge tone={statusTone(detail.status)}>{detail.status}</Badge> · Submitted{' '}
                  {fmtTime(detail.submitted_at)}
                </Text>
                {detail.created_company_id ? (
                  <Text as="p" tone="subdued">
                    Shopify Company: <code>{detail.created_company_id}</code>
                  </Text>
                ) : null}
              </BlockStack>

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Company
                </Text>
                <Text as="p">Name: {detail.form.companyName ?? '—'}</Text>
                <Text as="p">Country: {detail.form.countryCode ?? '—'}</Text>
                <Text as="p">Tax ID: {detail.form.taxId ?? '—'}</Text>
                {detail.form.gstNumber ? (
                  <Text as="p">GST: {detail.form.gstNumber}</Text>
                ) : null}
              </BlockStack>

              {Object.keys(detail.form.fields).length > 0 ? (
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Form responses
                  </Text>
                  {Object.entries(detail.form.fields).map(([k, v]) => (
                    <Text as="p" key={k}>
                      <Text as="span" tone="subdued">
                        {k}:
                      </Text>{' '}
                      {v}
                    </Text>
                  ))}
                </BlockStack>
              ) : null}

              {detail.form.documents.length > 0 ? (
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Documents
                  </Text>
                  {detail.form.documents.map(doc => (
                    <InlineStack key={doc.r2_key} gap="200" align="space-between">
                      <Text as="span">
                        {doc.name} · {bytesFmt(doc.size)}
                      </Text>
                      <Button variant="plain" onClick={() => void downloadDoc(detail.id, doc)}>
                        Download
                      </Button>
                    </InlineStack>
                  ))}
                </BlockStack>
              ) : null}

              {detail.status === 'submitted' || detail.status === 'needs_info' ? (
                <TextField
                  label="Decision notes (included in the email)"
                  value={notes}
                  onChange={setNotes}
                  multiline={3}
                  autoComplete="off"
                />
              ) : detail.decision_notes ? (
                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm">
                    Notes
                  </Text>
                  <Text as="p">{detail.decision_notes}</Text>
                </BlockStack>
              ) : null}
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </Page>
  );
}
