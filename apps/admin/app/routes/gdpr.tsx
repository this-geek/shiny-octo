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
  Page,
  Spinner,
  Text,
} from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';

type Kind =
  | 'customer_data_request'
  | 'customer_redact'
  | 'shop_redact'
  | 'app_uninstall_purge';

interface PendingRequest {
  id: string;
  kind: Kind;
  shopify_customer_id: string | null;
  received_at: number;
  due_at: number;
  status: 'pending';
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

function kindLabel(k: Kind): string {
  switch (k) {
    case 'customer_data_request':
      return 'Customer data export';
    case 'customer_redact':
      return 'Customer deletion';
    case 'shop_redact':
      return 'Shop deletion';
    case 'app_uninstall_purge':
      return 'Uninstall cleanup';
  }
}

function kindTone(k: Kind): 'attention' | 'info' | 'critical' {
  if (k === 'customer_data_request') return 'info';
  if (k === 'app_uninstall_purge') return 'attention';
  return 'critical';
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function fmtCountdown(due: number, now: number): string {
  const secs = due - now;
  if (secs <= 0) return 'due now';
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((secs % 3600) / 60);
  return `${hours}h ${mins}m`;
}

export default function Gdpr() {
  const { workerBase, initialIdToken } = useLoaderData<typeof loader>() as LoaderData;

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<PendingRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(t);
  }, []);

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
      const res = await fetch(`${workerBase}/admin/gdpr/pending`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { requests: PendingRequest[] };
      setRows(data.requests);
      setError(null);
    } catch (err) {
      setError(`Could not load: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [workerBase, initialIdToken]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  const callAction = useCallback(
    async (id: string, action: 'cancel' | 'process'): Promise<void> => {
      const verb = action === 'cancel' ? 'cancel' : 'process now';
      if (typeof window !== 'undefined' && !window.confirm(`Confirm: ${verb}?`)) return;
      const token = await getIdToken(initialIdToken);
      if (!token) return;
      setBusyId(`${id}:${action}`);
      try {
        const res = await fetch(`${workerBase}/admin/gdpr/${id}/${action}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        await fetchList();
      } catch (err) {
        setError(`Action failed: ${String(err)}`);
      } finally {
        setBusyId(null);
      }
    },
    [workerBase, initialIdToken, fetchList],
  );

  return (
    <Page title="Privacy requests">
      <Layout>
        <Layout.Section>
          <Banner title="Stand-down policy" tone="info">
            <p>
              Customer and shop deletion requests are held for 7 days before they
              run. Use <strong>Cancel</strong> to stop an accidental request, or
              <strong> Process now</strong> to skip the wait. After the stand-down
              elapses, the request runs on the next daily sweep.
            </p>
          </Banner>
        </Layout.Section>
        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </Layout.Section>
        )}
        <Layout.Section>
          <Card padding="0">
            {loading ? (
              <BlockStack inlineAlign="center" gap="400">
                <Spinner accessibilityLabel="Loading" />
              </BlockStack>
            ) : rows.length === 0 ? (
              <EmptyState
                heading="No pending privacy requests"
                image=""
              >
                <p>
                  Shopify sends GDPR webhooks here when a buyer requests their
                  data or deletion, or when an uninstalled shop reaches its
                  retention deadline. Nothing is currently queued.
                </p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: 'request', plural: 'requests' }}
                itemCount={rows.length}
                selectable={false}
                headings={[
                  { title: 'Kind' },
                  { title: 'Subject' },
                  { title: 'Received' },
                  { title: 'Runs in' },
                  { title: 'Actions' },
                ]}
              >
                {rows.map((row, index) => (
                  <IndexTable.Row id={row.id} key={row.id} position={index}>
                    <IndexTable.Cell>
                      <Badge tone={kindTone(row.kind)}>{kindLabel(row.kind)}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd">
                        {row.shopify_customer_id
                          ? `Customer ${row.shopify_customer_id}`
                          : 'Whole shop'}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" tone="subdued" variant="bodySm">
                        {fmtTime(row.received_at)}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd">
                        {fmtCountdown(row.due_at, now)}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        <Button
                          size="slim"
                          loading={busyId === `${row.id}:cancel`}
                          onClick={() => callAction(row.id, 'cancel')}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="slim"
                          variant="primary"
                          tone="critical"
                          loading={busyId === `${row.id}:process`}
                          onClick={() => callAction(row.id, 'process')}
                        >
                          Process now
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
    </Page>
  );
}
