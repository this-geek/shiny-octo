import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { useLoaderData } from '@remix-run/react';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  FormLayout,
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

interface Tier {
  id: number;
  name: string;
  discount_type: 'percent' | 'amount' | 'none';
  discount_value: number;
}

interface CompanyMapping {
  company_gid: string;
  tier_id: number;
  credit_limit: number | null;
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
  const env = (context as { cloudflare?: { env?: Record<string, string> } }).cloudflare?.env ?? {};
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

const COMPANY_GID_RE = /^gid:\/\/shopify\/Company\/[0-9]+$/;

interface FormState {
  company_gid: string;
  tier_id: string;
  credit_limit: string;
}

function emptyForm(): FormState {
  return { company_gid: '', tier_id: '', credit_limit: '' };
}

function formatDiscount(t: Tier | undefined): string {
  if (!t) return '—';
  if (t.discount_type === 'none') return '—';
  if (t.discount_type === 'percent') return `${t.discount_value}%`;
  return t.discount_value.toFixed(2);
}

export default function Companies() {
  const { workerBase, initialIdToken } = useLoaderData<typeof loader>() as LoaderData;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [mappings, setMappings] = useState<CompanyMapping[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CompanyMapping | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const tiersById = useMemo(() => {
    const m = new Map<number, Tier>();
    for (const t of tiers) m.set(t.id, t);
    return m;
  }, [tiers]);

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
      const [tiersRes, mappingsRes] = await Promise.all([
        fetch(`${workerBase}/admin/tiers`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${workerBase}/admin/company-mappings`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (!tiersRes.ok) throw new Error(`tiers HTTP ${tiersRes.status}`);
      if (!mappingsRes.ok) throw new Error(`mappings HTTP ${mappingsRes.status}`);
      const tiersData = (await tiersRes.json()) as { tiers: Tier[] };
      const mappingsData = (await mappingsRes.json()) as { mappings: CompanyMapping[] };
      setTiers(tiersData.tiers);
      setMappings(mappingsData.mappings);
      setError(null);
    } catch (err) {
      setError(`Could not load companies: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [workerBase, initialIdToken]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const openCreate = useCallback((): void => {
    setEditing(null);
    setForm({
      ...emptyForm(),
      tier_id: tiers[0]?.id ? String(tiers[0].id) : '',
    });
    setFormError(null);
    setModalOpen(true);
  }, [tiers]);

  const openEdit = useCallback((mapping: CompanyMapping): void => {
    setEditing(mapping);
    setForm({
      company_gid: mapping.company_gid,
      tier_id: String(mapping.tier_id),
      credit_limit: mapping.credit_limit === null ? '' : String(mapping.credit_limit),
    });
    setFormError(null);
    setModalOpen(true);
  }, []);

  const onSave = useCallback(async (): Promise<void> => {
    const gid = form.company_gid.trim();
    if (!COMPANY_GID_RE.test(gid)) {
      setFormError('Company GID must look like gid://shopify/Company/123456.');
      return;
    }
    const tier_id = Number.parseInt(form.tier_id, 10);
    if (!Number.isInteger(tier_id) || tier_id <= 0) {
      setFormError('Pick a tier.');
      return;
    }
    const credit_limit =
      form.credit_limit.trim() === '' ? null : Number(form.credit_limit);
    if (
      credit_limit !== null &&
      (!Number.isFinite(credit_limit) || credit_limit < 0)
    ) {
      setFormError('Credit limit must be a non-negative number, or blank.');
      return;
    }
    setSaving(true);
    setFormError(null);
    const token = await getIdToken(initialIdToken);
    if (!token) {
      setFormError('No session token available.');
      setSaving(false);
      return;
    }
    try {
      const res = await fetch(
        `${workerBase}/admin/company-mappings/${encodeURIComponent(gid)}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier_id, credit_limit }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setModalOpen(false);
      await fetchAll();
    } catch (err) {
      setFormError(`Could not save: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [form, workerBase, initialIdToken, fetchAll]);

  const onDelete = useCallback(
    async (mapping: CompanyMapping): Promise<void> => {
      if (
        typeof window !== 'undefined' &&
        !window.confirm(`Unmap ${mapping.company_gid}? The Company metafield will be cleared.`)
      ) {
        return;
      }
      const token = await getIdToken(initialIdToken);
      if (!token) {
        setError('No session token available.');
        return;
      }
      try {
        const res = await fetch(
          `${workerBase}/admin/company-mappings/${encodeURIComponent(mapping.company_gid)}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await fetchAll();
      } catch (err) {
        setError(`Could not delete mapping: ${String(err)}`);
      }
    },
    [workerBase, initialIdToken, fetchAll],
  );

  const tierOptions = useMemo(
    () => tiers.map(t => ({ label: t.name, value: String(t.id) })),
    [tiers],
  );

  if (loading) {
    return (
      <Page title="Companies" backAction={{ content: 'Home', url: '/' }}>
        <InlineStack align="center" gap="200">
          <Spinner accessibilityLabel="Loading" size="small" />
          <Text as="span">Loading companies…</Text>
        </InlineStack>
      </Page>
    );
  }

  const noTiers = tiers.length === 0;

  return (
    <Page
      title="Companies"
      backAction={{ content: 'Home', url: '/' }}
      primaryAction={{
        content: 'Map a company',
        onAction: openCreate,
        disabled: noTiers,
      }}
    >
      <Layout>
        {error ? (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
          </Layout.Section>
        ) : null}

        {noTiers ? (
          <Layout.Section>
            <Banner tone="warning">
              <p>
                Create at least one tier before mapping companies. Open{' '}
                <a href="/tiers">Tiers</a> to add one.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Companies, Locations, Catalogs and payment terms remain Shopify&apos;s native
                objects. This page maps a Shopify Company GID to a B2B Companion tier — every
                save mirrors <code>b2b.tier_id</code> onto the Company metafield for the
                cart-transform Function.
              </Text>
              <Text as="p" tone="subdued">
                Copy the Company GID from Shopify admin: open the company and look at the URL
                (<code>/companies/123456</code>) — the GID is{' '}
                <code>gid://shopify/Company/123456</code>.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            {mappings.length === 0 ? (
              <EmptyState
                heading="No company mappings yet"
                action={
                  noTiers
                    ? undefined
                    : { content: 'Map your first company', onAction: openCreate }
                }
                image=""
              >
                <p>
                  Map a Shopify Company to a tier so its buyers see the configured discount,
                  minimums, and shipping rules at checkout.
                </p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: 'mapping', plural: 'mappings' }}
                itemCount={mappings.length}
                selectable={false}
                headings={[
                  { title: 'Company GID' },
                  { title: 'Tier' },
                  { title: 'Discount' },
                  { title: 'Credit limit' },
                  { title: '' },
                ]}
              >
                {mappings.map((mapping, index) => {
                  const tier = tiersById.get(mapping.tier_id);
                  return (
                    <IndexTable.Row id={mapping.company_gid} key={mapping.company_gid} position={index}>
                      <IndexTable.Cell>
                        <Text as="span" truncate>{mapping.company_gid}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {tier ? (
                          <Text as="span" fontWeight="medium">{tier.name}</Text>
                        ) : (
                          <Badge tone="critical">{`deleted tier #${mapping.tier_id}`}</Badge>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>{formatDiscount(tier)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {mapping.credit_limit === null
                          ? '—'
                          : `$${mapping.credit_limit.toFixed(2)}`}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="200">
                          <Button variant="plain" onClick={() => openEdit(mapping)}>Edit</Button>
                          <Button
                            variant="plain"
                            tone="critical"
                            onClick={() => void onDelete(mapping)}
                          >
                            Unmap
                          </Button>
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing === null ? 'Map a company to a tier' : 'Edit mapping'}
        primaryAction={{
          content: editing === null ? 'Map' : 'Save',
          onAction: () => void onSave(),
          loading: saving,
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {formError ? <Banner tone="critical">{formError}</Banner> : null}
            <FormLayout>
              <TextField
                label="Company GID"
                value={form.company_gid}
                onChange={v => setForm({ ...form, company_gid: v })}
                autoComplete="off"
                disabled={editing !== null}
                requiredIndicator
                helpText="From Shopify admin URL: gid://shopify/Company/<numeric id>"
              />
              <Select
                label="Tier"
                options={tierOptions}
                value={form.tier_id}
                onChange={v => setForm({ ...form, tier_id: v })}
              />
              <TextField
                label="Credit limit"
                value={form.credit_limit}
                onChange={v => setForm({ ...form, credit_limit: v })}
                type="number"
                autoComplete="off"
                helpText="Optional. Used by Day-2 credit-limit enforcement; safe to leave blank."
              />
            </FormLayout>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
