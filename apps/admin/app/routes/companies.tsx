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
  shopify_company_id: string;
  tier_id: number;
  credit_limit: number | null;
}

interface ShopifyCompany {
  id: string;
  name: string;
  externalId: string | null;
  locationsCount: number | null;
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

interface FormState {
  shopify_company_id: string;
  tier_id: string;
  credit_limit: string;
}

function emptyForm(): FormState {
  return { shopify_company_id: '', tier_id: '', credit_limit: '' };
}

function formatDiscount(t: Tier | undefined): string {
  if (!t) return '—';
  if (t.discount_type === 'none') return '—';
  if (t.discount_type === 'percent') return `${t.discount_value}%`;
  return t.discount_value.toFixed(2);
}

function companyNumericId(gid: string): string {
  const m = /^gid:\/\/shopify\/Company\/([0-9]+)$/.exec(gid);
  return m ? m[1] : gid;
}

export default function Companies() {
  const { workerBase, initialIdToken } = useLoaderData<typeof loader>() as LoaderData;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [mappings, setMappings] = useState<CompanyMapping[]>([]);
  const [companies, setCompanies] = useState<ShopifyCompany[]>([]);
  const [companiesError, setCompaniesError] = useState<string | null>(null);
  const [companiesTruncated, setCompaniesTruncated] = useState(false);

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

  const companiesByGid = useMemo(() => {
    const m = new Map<string, ShopifyCompany>();
    for (const c of companies) m.set(c.id, c);
    return m;
  }, [companies]);

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
      const [tiersRes, mappingsRes, companiesRes] = await Promise.all([
        fetch(`${workerBase}/admin/tiers`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${workerBase}/admin/company-mappings`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${workerBase}/admin/shopify-companies`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (!tiersRes.ok) throw new Error(`tiers HTTP ${tiersRes.status}`);
      if (!mappingsRes.ok) throw new Error(`mappings HTTP ${mappingsRes.status}`);
      const tiersData = (await tiersRes.json()) as { tiers: Tier[] };
      const mappingsData = (await mappingsRes.json()) as { mappings: CompanyMapping[] };
      setTiers(tiersData.tiers);
      setMappings(mappingsData.mappings);

      if (companiesRes.ok) {
        const data = (await companiesRes.json()) as {
          companies: ShopifyCompany[];
          truncated: boolean;
        };
        setCompanies(data.companies);
        setCompaniesTruncated(data.truncated);
        setCompaniesError(null);
      } else {
        const j = (await companiesRes.json().catch(() => ({}))) as { error?: string };
        setCompaniesError(j.error ?? `companies HTTP ${companiesRes.status}`);
      }
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
    const mappedGids = new Set(mappings.map(m => m.shopify_company_id));
    const firstUnmapped = companies.find(c => !mappedGids.has(c.id));
    setForm({
      ...emptyForm(),
      shopify_company_id: firstUnmapped?.id ?? companies[0]?.id ?? '',
      tier_id: tiers[0]?.id ? String(tiers[0].id) : '',
    });
    setFormError(null);
    setModalOpen(true);
  }, [tiers, companies, mappings]);

  const openEdit = useCallback((mapping: CompanyMapping): void => {
    setEditing(mapping);
    setForm({
      shopify_company_id: mapping.shopify_company_id,
      tier_id: String(mapping.tier_id),
      credit_limit: mapping.credit_limit === null ? '' : String(mapping.credit_limit),
    });
    setFormError(null);
    setModalOpen(true);
  }, []);

  const onSave = useCallback(async (): Promise<void> => {
    const gid = form.shopify_company_id;
    if (!/^gid:\/\/shopify\/Company\/[0-9]+$/.test(gid)) {
      setFormError('Pick a company from the list.');
      return;
    }
    const tier_id = Number.parseInt(form.tier_id, 10);
    if (!Number.isInteger(tier_id) || tier_id <= 0) {
      setFormError('Pick a tier.');
      return;
    }
    const credit_limit =
      form.credit_limit.trim() === '' ? null : Number(form.credit_limit);
    if (credit_limit !== null && (!Number.isFinite(credit_limit) || credit_limit < 0)) {
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
      const name = companiesByGid.get(mapping.shopify_company_id)?.name ?? mapping.shopify_company_id;
      if (
        typeof window !== 'undefined' &&
        !window.confirm(`Unmap ${name}? The Company metafield will be cleared.`)
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
          `${workerBase}/admin/company-mappings/${encodeURIComponent(mapping.shopify_company_id)}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await fetchAll();
      } catch (err) {
        setError(`Could not delete mapping: ${String(err)}`);
      }
    },
    [workerBase, initialIdToken, fetchAll, companiesByGid],
  );

  const tierOptions = useMemo(
    () => tiers.map(t => ({ label: t.name, value: String(t.id) })),
    [tiers],
  );

  const companyOptions = useMemo(() => {
    const mappedGids = editing ? new Set<string>() : new Set(mappings.map(m => m.shopify_company_id));
    return companies
      .filter(c => editing?.shopify_company_id === c.id || !mappedGids.has(c.id))
      .map(c => ({ label: c.name, value: c.id }));
  }, [companies, mappings, editing]);

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
  const noCompanies = companies.length === 0;
  const noUnmapped = !noCompanies && companyOptions.length === 0 && editing === null;

  return (
    <Page
      title="Companies"
      backAction={{ content: 'Home', url: '/' }}
      primaryAction={{
        content: 'Map a company',
        onAction: openCreate,
        disabled: noTiers || noCompanies || noUnmapped,
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

        {companiesError ? (
          <Layout.Section>
            <Banner tone="warning" onDismiss={() => setCompaniesError(null)}>
              <p>
                Could not load Shopify companies: {companiesError}. You can still see
                existing mappings below, but adding a new one needs this list.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        {companiesTruncated ? (
          <Layout.Section>
            <Banner tone="info">
              <p>
                Showing the first 1,000 companies from your store. If the one you want is
                missing, narrow the list in Shopify admin or contact support.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Companies, Locations, Catalogs and payment terms remain Shopify&apos;s native
                objects. This page maps a Shopify Company to a B2B Companion tier — every
                save mirrors <code>b2b.tier_id</code> onto the Company metafield for the
                cart-transform Function.
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
                  noTiers || noCompanies
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
                  { title: 'Company' },
                  { title: 'Tier' },
                  { title: 'Discount' },
                  { title: 'Credit limit' },
                  { title: '' },
                ]}
              >
                {mappings.map((mapping, index) => {
                  const tier = tiersById.get(mapping.tier_id);
                  const company = companiesByGid.get(mapping.shopify_company_id);
                  const numericId = companyNumericId(mapping.shopify_company_id);
                  return (
                    <IndexTable.Row
                      id={mapping.shopify_company_id}
                      key={mapping.shopify_company_id}
                      position={index}
                    >
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text as="span" fontWeight="medium">
                            {company?.name ?? `Company ${numericId}`}
                          </Text>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {`#${numericId}`}
                          </Text>
                        </BlockStack>
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
          disabled: companyOptions.length === 0,
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {formError ? <Banner tone="critical">{formError}</Banner> : null}
            <FormLayout>
              {editing === null ? (
                <Select
                  label="Company"
                  options={companyOptions}
                  value={form.shopify_company_id}
                  onChange={v => setForm({ ...form, shopify_company_id: v })}
                  helpText={
                    companyOptions.length === 0
                      ? 'Every company is already mapped. Edit an existing row instead.'
                      : `${companyOptions.length} unmapped compan${companyOptions.length === 1 ? 'y' : 'ies'} available.`
                  }
                />
              ) : (
                <TextField
                  label="Company"
                  value={
                    companiesByGid.get(editing.shopify_company_id)?.name ?? editing.shopify_company_id
                  }
                  onChange={() => {}}
                  autoComplete="off"
                  disabled
                />
              )}
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
