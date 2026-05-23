import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { useLoaderData } from '@remix-run/react';
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  FormLayout,
  InlineStack,
  Layout,
  Page,
  Select,
  Spinner,
  Text,
  TextField,
} from '@shopify/polaris';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface ApplicationFormField {
  id: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'textarea' | 'select' | 'file';
  required: boolean;
  options?: string[];
}

interface AdminSettings {
  brand?: { primaryColor?: string; accentColor?: string };
  applicationForm?: { fields: ApplicationFormField[]; requireDocuments: boolean };
  emailTemplates?: {
    approved?: { subject: string; body: string };
    rejected?: { subject: string; body: string };
    moreInfo?: { subject: string; body: string };
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
  const env = (context as { cloudflare?: { env?: Record<string, string> } }).cloudflare?.env ?? {};
  const workerBase = env.WORKER_URL ?? env.APP_URL ?? '';
  return json<LoaderData>({
    workerBase,
    initialIdToken: url.searchParams.get('id_token'),
  });
}

const HEX = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_TEMPLATES = {
  approved: {
    subject: 'Welcome to wholesale',
    body: 'Hi {{first_name}},\n\nYour wholesale application has been approved.',
  },
  rejected: {
    subject: 'Wholesale application update',
    body: 'Hi {{first_name}},\n\nWe were unable to approve your wholesale application at this time.',
  },
  moreInfo: {
    subject: 'A little more information please',
    body: 'Hi {{first_name}},\n\nWe need a little more information to review your application.',
  },
};

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

export default function Settings() {
  const { workerBase, initialIdToken } = useLoaderData<typeof loader>() as LoaderData;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [primaryColor, setPrimaryColor] = useState('#1a73e8');
  const [accentColor, setAccentColor] = useState('#34a853');

  const [requireDocuments, setRequireDocuments] = useState(false);
  const [fields, setFields] = useState<ApplicationFormField[]>([]);

  const [approvedSubject, setApprovedSubject] = useState(DEFAULT_TEMPLATES.approved.subject);
  const [approvedBody, setApprovedBody] = useState(DEFAULT_TEMPLATES.approved.body);
  const [rejectedSubject, setRejectedSubject] = useState(DEFAULT_TEMPLATES.rejected.subject);
  const [rejectedBody, setRejectedBody] = useState(DEFAULT_TEMPLATES.rejected.body);
  const [moreInfoSubject, setMoreInfoSubject] = useState(DEFAULT_TEMPLATES.moreInfo.subject);
  const [moreInfoBody, setMoreInfoBody] = useState(DEFAULT_TEMPLATES.moreInfo.body);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!workerBase) {
        setError('Worker URL is not configured. Set WORKER_URL on the Pages project.');
        setLoading(false);
        return;
      }
      const token = await getIdToken(initialIdToken);
      if (!token) {
        setError(
          'No session token available. Open the app from the Shopify admin to authenticate.',
        );
        setLoading(false);
        return;
      }
      try {
        const res = await fetch(`${workerBase}/admin/settings`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as AdminSettings;
        if (cancelled) return;
        if (data.brand?.primaryColor) setPrimaryColor(data.brand.primaryColor);
        if (data.brand?.accentColor) setAccentColor(data.brand.accentColor);
        if (data.applicationForm) {
          setFields(data.applicationForm.fields ?? []);
          setRequireDocuments(data.applicationForm.requireDocuments ?? false);
        }
        if (data.emailTemplates?.approved) {
          setApprovedSubject(data.emailTemplates.approved.subject);
          setApprovedBody(data.emailTemplates.approved.body);
        }
        if (data.emailTemplates?.rejected) {
          setRejectedSubject(data.emailTemplates.rejected.subject);
          setRejectedBody(data.emailTemplates.rejected.body);
        }
        if (data.emailTemplates?.moreInfo) {
          setMoreInfoSubject(data.emailTemplates.moreInfo.subject);
          setMoreInfoBody(data.emailTemplates.moreInfo.body);
        }
      } catch (err) {
        if (!cancelled) setError(`Could not load settings: ${String(err)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return (): void => {
      cancelled = true;
    };
  }, [workerBase, initialIdToken]);

  const brandValid = HEX.test(primaryColor) && HEX.test(accentColor);

  const onAddField = useCallback((): void => {
    setFields(prev => [
      ...prev,
      {
        id: `field_${prev.length + 1}`,
        label: 'New field',
        type: 'text',
        required: false,
      },
    ]);
  }, []);

  const onRemoveField = useCallback((index: number): void => {
    setFields(prev => prev.filter((_, i) => i !== index));
  }, []);

  const onPatchField = useCallback(
    (index: number, patch: Partial<ApplicationFormField>): void => {
      setFields(prev => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
    },
    [],
  );

  const onSave = useCallback(async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const token = await getIdToken(initialIdToken);
    if (!token) {
      setError('No session token available.');
      setSaving(false);
      return;
    }
    const payload: AdminSettings = {
      brand: { primaryColor, accentColor },
      applicationForm: { fields, requireDocuments },
      emailTemplates: {
        approved: { subject: approvedSubject, body: approvedBody },
        rejected: { subject: rejectedSubject, body: rejectedBody },
        moreInfo: { subject: moreInfoSubject, body: moreInfoBody },
      },
    };
    try {
      const res = await fetch(`${workerBase}/admin/settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setSaved(true);
    } catch (err) {
      setError(`Could not save: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [
    workerBase,
    initialIdToken,
    primaryColor,
    accentColor,
    fields,
    requireDocuments,
    approvedSubject,
    approvedBody,
    rejectedSubject,
    rejectedBody,
    moreInfoSubject,
    moreInfoBody,
  ]);

  const fieldTypeOptions = useMemo(
    () => [
      { label: 'Single-line text', value: 'text' },
      { label: 'Email', value: 'email' },
      { label: 'Phone', value: 'tel' },
      { label: 'Multi-line text', value: 'textarea' },
      { label: 'Dropdown', value: 'select' },
      { label: 'File upload', value: 'file' },
    ],
    [],
  );

  if (loading) {
    return (
      <Page title="Settings">
        <InlineStack align="center" gap="200">
          <Spinner accessibilityLabel="Loading" size="small" />
          <Text as="span">Loading settings…</Text>
        </InlineStack>
      </Page>
    );
  }

  return (
    <Page
      title="Settings"
      backAction={{ content: 'Home', url: '/' }}
      primaryAction={{
        content: saving ? 'Saving…' : 'Save',
        onAction: () => void onSave(),
        loading: saving,
        disabled: !brandValid,
      }}
    >
      <Layout>
        {error ? (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </Layout.Section>
        ) : null}
        {saved ? (
          <Layout.Section>
            <Banner tone="success" onDismiss={() => setSaved(false)}>
              Settings saved.
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.AnnotatedSection
          title="Brand"
          description="Used on the wholesale application form, buyer onboarding emails, and the buyer asset portal."
        >
          <Card>
            <FormLayout>
              <TextField
                label="Primary colour"
                value={primaryColor}
                onChange={setPrimaryColor}
                autoComplete="off"
                helpText="Hex colour, e.g. #1a73e8"
                error={!HEX.test(primaryColor) ? 'Must be #rrggbb' : undefined}
              />
              <TextField
                label="Accent colour"
                value={accentColor}
                onChange={setAccentColor}
                autoComplete="off"
                helpText="Hex colour, e.g. #34a853"
                error={!HEX.test(accentColor) ? 'Must be #rrggbb' : undefined}
              />
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Application form"
          description="Fields a prospective wholesale buyer fills in to apply. Tax ID is added automatically per locale and is not editable here."
        >
          <Card>
            <BlockStack gap="400">
              <Checkbox
                label="Require document upload"
                helpText="Buyers must attach a business document (e.g. trading licence) before submitting."
                checked={requireDocuments}
                onChange={setRequireDocuments}
              />
              <BlockStack gap="300">
                {fields.map((field, i) => (
                  <Card key={i}>
                    <FormLayout>
                      <FormLayout.Group>
                        <TextField
                          label="Field ID"
                          value={field.id}
                          autoComplete="off"
                          helpText="Lowercase, used in webhooks. Max 40 chars."
                          onChange={v => onPatchField(i, { id: v })}
                        />
                        <TextField
                          label="Label"
                          value={field.label}
                          autoComplete="off"
                          onChange={v => onPatchField(i, { label: v })}
                        />
                      </FormLayout.Group>
                      <FormLayout.Group>
                        <Select
                          label="Type"
                          options={fieldTypeOptions}
                          value={field.type}
                          onChange={v =>
                            onPatchField(i, {
                              type: v as ApplicationFormField['type'],
                              options: v === 'select' ? (field.options ?? ['']) : undefined,
                            })
                          }
                        />
                        <Checkbox
                          label="Required"
                          checked={field.required}
                          onChange={v => onPatchField(i, { required: v })}
                        />
                      </FormLayout.Group>
                      {field.type === 'select' ? (
                        <TextField
                          label="Options (one per line)"
                          value={(field.options ?? []).join('\n')}
                          multiline={3}
                          autoComplete="off"
                          onChange={v =>
                            onPatchField(i, {
                              options: v.split('\n').map(s => s.trim()).filter(Boolean),
                            })
                          }
                        />
                      ) : null}
                      <InlineStack align="end">
                        <Button
                          tone="critical"
                          variant="plain"
                          onClick={() => onRemoveField(i)}
                        >
                          Remove field
                        </Button>
                      </InlineStack>
                    </FormLayout>
                  </Card>
                ))}
                <InlineStack align="start">
                  <Button onClick={onAddField}>Add field</Button>
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Email templates"
          description="Sent via Resend. {{first_name}}, {{shop}} and {{reference}} placeholders are substituted at send time."
        >
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Approved</Text>
                <TextField
                  label="Subject"
                  value={approvedSubject}
                  onChange={setApprovedSubject}
                  autoComplete="off"
                />
                <TextField
                  label="Body"
                  value={approvedBody}
                  onChange={setApprovedBody}
                  multiline={4}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Rejected</Text>
                <TextField
                  label="Subject"
                  value={rejectedSubject}
                  onChange={setRejectedSubject}
                  autoComplete="off"
                />
                <TextField
                  label="Body"
                  value={rejectedBody}
                  onChange={setRejectedBody}
                  multiline={4}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Request more information</Text>
                <TextField
                  label="Subject"
                  value={moreInfoSubject}
                  onChange={setMoreInfoSubject}
                  autoComplete="off"
                />
                <TextField
                  label="Body"
                  value={moreInfoBody}
                  onChange={setMoreInfoBody}
                  multiline={4}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.AnnotatedSection>
      </Layout>
    </Page>
  );
}
