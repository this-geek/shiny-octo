import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { useLoaderData } from '@remix-run/react';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
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

type DiscountType = 'percent' | 'amount' | 'none';

interface Tier {
  id: number;
  shop_id: number;
  name: string;
  discount_type: DiscountType;
  discount_value: number;
  min_order_value: number | null;
  min_order_units: number | null;
  free_shipping_threshold: number | null;
  flat_shipping_amount: number | null;
  pickup_only: boolean;
  priority: number;
  deleted_at: number | null;
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
  name: string;
  discount_type: DiscountType;
  discount_value: string;
  min_order_value: string;
  min_order_units: string;
  free_shipping_threshold: string;
  flat_shipping_amount: string;
  pickup_only: boolean;
  priority: string;
}

function emptyForm(): FormState {
  return {
    name: '',
    discount_type: 'percent',
    discount_value: '10',
    min_order_value: '',
    min_order_units: '',
    free_shipping_threshold: '',
    flat_shipping_amount: '',
    pickup_only: false,
    priority: '0',
  };
}

function tierToForm(t: Tier): FormState {
  return {
    name: t.name,
    discount_type: t.discount_type,
    discount_value: String(t.discount_value),
    min_order_value: t.min_order_value === null ? '' : String(t.min_order_value),
    min_order_units: t.min_order_units === null ? '' : String(t.min_order_units),
    free_shipping_threshold:
      t.free_shipping_threshold === null ? '' : String(t.free_shipping_threshold),
    flat_shipping_amount:
      t.flat_shipping_amount === null ? '' : String(t.flat_shipping_amount),
    pickup_only: t.pickup_only,
    priority: String(t.priority),
  };
}

function formToPayload(f: FormState): {
  payload: Record<string, unknown> | null;
  error: string | null;
} {
  if (!f.name.trim()) return { payload: null, error: 'Name is required' };
  const num = (s: string): number | null => (s.trim() === '' ? null : Number(s));
  const discount_value = Number(f.discount_value);
  if (!Number.isFinite(discount_value) || discount_value < 0) {
    return { payload: null, error: 'Discount value must be a non-negative number' };
  }
  if (f.discount_type === 'percent' && discount_value > 100) {
    return { payload: null, error: 'Percent discount cannot exceed 100' };
  }
  const priority = Number.parseInt(f.priority, 10);
  if (!Number.isInteger(priority) || priority < 0) {
    return { payload: null, error: 'Priority must be a non-negative integer' };
  }
  return {
    error: null,
    payload: {
      name: f.name.trim(),
      discount_type: f.discount_type,
      discount_value,
      min_order_value: num(f.min_order_value),
      min_order_units: num(f.min_order_units),
      free_shipping_threshold: num(f.free_shipping_threshold),
      flat_shipping_amount: num(f.flat_shipping_amount),
      pickup_only: f.pickup_only,
      priority,
    },
  };
}

function formatDiscount(t: Tier): string {
  if (t.discount_type === 'none') return '—';
  if (t.discount_type === 'percent') return `${t.discount_value}%`;
  return t.discount_value.toFixed(2);
}

export default function Tiers() {
  const { workerBase, initialIdToken } = useLoaderData<typeof loader>() as LoaderData;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fetchTiers = useCallback(async (): Promise<void> => {
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
      const res = await fetch(`${workerBase}/admin/tiers`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { tiers: Tier[] };
      setTiers(data.tiers);
      setError(null);
    } catch (err) {
      setError(`Could not load tiers: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [workerBase, initialIdToken]);

  useEffect(() => {
    void fetchTiers();
  }, [fetchTiers]);

  const openCreate = useCallback((): void => {
    setEditingId(null);
    setForm(emptyForm());
    setFormError(null);
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((tier: Tier): void => {
    setEditingId(tier.id);
    setForm(tierToForm(tier));
    setFormError(null);
    setModalOpen(true);
  }, []);

  const onSave = useCallback(async (): Promise<void> => {
    const { payload, error: validationError } = formToPayload(form);
    if (validationError || !payload) {
      setFormError(validationError);
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
      const url = editingId === null
        ? `${workerBase}/admin/tiers`
        : `${workerBase}/admin/tiers/${editingId}`;
      const method = editingId === null ? 'POST' : 'PUT';
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setModalOpen(false);
      await fetchTiers();
    } catch (err) {
      setFormError(`Could not save: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [editingId, form, workerBase, initialIdToken, fetchTiers]);

  const onDelete = useCallback(
    async (tierId: number): Promise<void> => {
      if (typeof window !== 'undefined' && !window.confirm('Delete this tier? Companies mapped to it keep the mapping but the discount stops applying.')) {
        return;
      }
      const token = await getIdToken(initialIdToken);
      if (!token) {
        setError('No session token available.');
        return;
      }
      try {
        const res = await fetch(`${workerBase}/admin/tiers/${tierId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await fetchTiers();
      } catch (err) {
        setError(`Could not delete: ${String(err)}`);
      }
    },
    [workerBase, initialIdToken, fetchTiers],
  );

  const discountTypeOptions = useMemo(
    () => [
      { label: 'Percent off', value: 'percent' },
      { label: 'Fixed amount off (per unit)', value: 'amount' },
      { label: 'No discount', value: 'none' },
    ],
    [],
  );

  if (loading) {
    return (
      <Page title="Tiers">
        <InlineStack align="center" gap="200">
          <Spinner accessibilityLabel="Loading" size="small" />
          <Text as="span">Loading tiers…</Text>
        </InlineStack>
      </Page>
    );
  }

  return (
    <Page
      title="Tiers"
      backAction={{ content: 'Home', url: '/' }}
      primaryAction={{ content: 'Create tier', onAction: openCreate }}
    >
      <Layout>
        {error ? (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            {tiers.length === 0 ? (
              <EmptyState
                heading="No tiers yet"
                action={{ content: 'Create your first tier', onAction: openCreate }}
                image=""
              >
                <p>
                  A tier bundles a discount, order minimums, and shipping rules. Map a
                  Shopify Company to a tier to have those rules apply to its buyers.
                </p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: 'tier', plural: 'tiers' }}
                itemCount={tiers.length}
                selectable={false}
                headings={[
                  { title: 'Name' },
                  { title: 'Discount' },
                  { title: 'Min order' },
                  { title: 'Shipping' },
                  { title: 'Priority' },
                  { title: '' },
                ]}
              >
                {tiers.map((tier, index) => (
                  <IndexTable.Row id={String(tier.id)} key={tier.id} position={index}>
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="medium">{tier.name}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{formatDiscount(tier)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {tier.min_order_value ? `$${tier.min_order_value.toFixed(2)}` : '—'}
                      {tier.min_order_units ? ` / ${tier.min_order_units}u` : ''}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {tier.pickup_only ? <Badge tone="info">Pickup only</Badge> : null}
                      {!tier.pickup_only && tier.free_shipping_threshold
                        ? `Free over $${tier.free_shipping_threshold.toFixed(2)}`
                        : null}
                      {!tier.pickup_only && tier.flat_shipping_amount
                        ? ` / Flat $${tier.flat_shipping_amount.toFixed(2)}`
                        : null}
                      {!tier.pickup_only && !tier.free_shipping_threshold && !tier.flat_shipping_amount
                        ? '—'
                        : null}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{tier.priority}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        <Button variant="plain" onClick={() => openEdit(tier)}>Edit</Button>
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => void onDelete(tier.id)}
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
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId === null ? 'Create tier' : 'Edit tier'}
        primaryAction={{
          content: editingId === null ? 'Create' : 'Save',
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
                label="Name"
                value={form.name}
                onChange={v => setForm({ ...form, name: v })}
                autoComplete="off"
                requiredIndicator
              />
              <FormLayout.Group>
                <Select
                  label="Discount type"
                  options={discountTypeOptions}
                  value={form.discount_type}
                  onChange={v => setForm({ ...form, discount_type: v as DiscountType })}
                />
                <TextField
                  label="Discount value"
                  value={form.discount_value}
                  onChange={v => setForm({ ...form, discount_value: v })}
                  type="number"
                  autoComplete="off"
                  disabled={form.discount_type === 'none'}
                  suffix={form.discount_type === 'percent' ? '%' : undefined}
                />
              </FormLayout.Group>
              <FormLayout.Group>
                <TextField
                  label="Min order value"
                  value={form.min_order_value}
                  onChange={v => setForm({ ...form, min_order_value: v })}
                  type="number"
                  autoComplete="off"
                  helpText="Cart total (after discount) must be at least this."
                />
                <TextField
                  label="Min order units"
                  value={form.min_order_units}
                  onChange={v => setForm({ ...form, min_order_units: v })}
                  type="number"
                  autoComplete="off"
                />
              </FormLayout.Group>
              <FormLayout.Group>
                <TextField
                  label="Free shipping threshold"
                  value={form.free_shipping_threshold}
                  onChange={v => setForm({ ...form, free_shipping_threshold: v })}
                  type="number"
                  autoComplete="off"
                  disabled={form.pickup_only}
                />
                <TextField
                  label="Flat shipping amount"
                  value={form.flat_shipping_amount}
                  onChange={v => setForm({ ...form, flat_shipping_amount: v })}
                  type="number"
                  autoComplete="off"
                  disabled={form.pickup_only}
                />
              </FormLayout.Group>
              <Checkbox
                label="Pickup only"
                checked={form.pickup_only}
                onChange={v => setForm({ ...form, pickup_only: v })}
                helpText="Hides every non-pickup delivery option at checkout."
              />
              <TextField
                label="Priority"
                value={form.priority}
                onChange={v => setForm({ ...form, priority: v })}
                type="number"
                autoComplete="off"
                helpText="Lower numbers sort first in the admin list."
              />
            </FormLayout>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
