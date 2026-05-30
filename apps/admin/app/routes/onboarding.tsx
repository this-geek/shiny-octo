import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { useLoaderData } from '@remix-run/react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Link,
  List,
  Page,
  ProgressBar,
  Spinner,
  Text,
} from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';

type StepId = 'detect' | 'tiers' | 'application' | 'assets' | 'test_buyer' | 'go_live';

interface StepState {
  done: boolean;
  skipped: boolean;
  completed_at?: number;
  data?: Record<string, unknown>;
}

interface OnboardingState {
  status: 'pending' | 'completed' | 'dismissed';
  current_step: StepId;
  steps: Record<StepId, StepState>;
  started_at: number;
  completed_at?: number;
  dismissed_at?: number;
}

interface StateResponse {
  state: OnboardingState;
  skippable: StepId[];
  steps: StepId[];
}

interface DetectedSetup {
  companies: number;
  catalogs: number | null;
  markets: number;
  wholesale_tagged_customers: number;
  fetched_at: number;
}

interface TestBuyerData {
  email?: string;
  company_id?: string;
  customer_id?: string;
  invite_sent?: boolean;
  invite_reason?: string;
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

const STEP_TITLES: Record<StepId, string> = {
  detect: '1. Detect existing setup',
  tiers: '2. Configure tiers',
  application: '3. Build the registration form',
  assets: '4. Bootstrap the asset library',
  test_buyer: '5. Create a test buyer',
  go_live: '6. Go-live checklist',
};

const STEP_ORDER: StepId[] = ['detect', 'tiers', 'application', 'assets', 'test_buyer', 'go_live'];

export default function Onboarding() {
  const { workerBase, initialIdToken } = useLoaderData<typeof loader>() as LoaderData;
  const [data, setData] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const call = useCallback(
    async (path: string, body?: object): Promise<Response> => {
      const token = await getIdToken(initialIdToken);
      if (!token) throw new Error('missing id_token — open the app from the Shopify admin');
      return fetch(`${workerBase}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    },
    [workerBase, initialIdToken],
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await call('/admin/onboarding/state');
      if (!res.ok) throw new Error(`state ${res.status}`);
      setData((await res.json()) as StateResponse);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [call]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (path: string, body?: object): Promise<unknown> => {
      setBusy(true);
      setError(null);
      try {
        const res = await call(path, body ?? {});
        const json = (await res.json().catch(() => ({}))) as { state?: OnboardingState; error?: string };
        if (!res.ok) throw new Error(json.error ?? `request failed ${res.status}`);
        if (json.state) {
          setData(prev => (prev ? { ...prev, state: json.state as OnboardingState } : prev));
        }
        return json;
      } catch (e) {
        setError(String((e as Error).message ?? e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [call],
  );

  if (!data) {
    return (
      <Page title="Onboarding">
        {error ? <Banner tone="critical">{error}</Banner> : <Spinner />}
      </Page>
    );
  }

  const { state, skippable } = data;
  const skippableSet = new Set<StepId>(skippable);
  const doneCount = STEP_ORDER.filter(id => state.steps[id].done || state.steps[id].skipped).length;
  const allDone = STEP_ORDER.every(
    id => state.steps[id].done || (state.steps[id].skipped && skippableSet.has(id)),
  );

  return (
    <Page
      title="Set up B2B Companion"
      subtitle={
        state.status === 'completed'
          ? 'All set — you can revisit any step from here.'
          : state.status === 'dismissed'
            ? 'Wizard dismissed. You can resume from here at any time.'
            : `Step ${STEP_ORDER.indexOf(state.current_step) + 1} of ${STEP_ORDER.length}.`
      }
      backAction={{ content: 'Home', url: '/' }}
      secondaryActions={
        state.status === 'pending'
          ? [{ content: 'Dismiss wizard', onAction: () => void act('/admin/onboarding/dismiss') }]
          : [{ content: 'Reset wizard', onAction: () => void act('/admin/onboarding/reset') }]
      }
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Progress</Text>
              <ProgressBar progress={Math.round((doneCount / STEP_ORDER.length) * 100)} />
              <Text as="p" tone="subdued">
                {doneCount} of {STEP_ORDER.length} steps complete.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {STEP_ORDER.map(id => (
          <Layout.Section key={id}>
            <StepCard
              id={id}
              state={state.steps[id]}
              isCurrent={state.current_step === id && state.status === 'pending'}
              skippable={skippableSet.has(id)}
              busy={busy}
              workerBase={workerBase}
              call={call}
              act={act}
            />
          </Layout.Section>
        ))}

        {allDone && state.status === 'pending' && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Ready to go live?</Text>
                <Text as="p" tone="subdued">
                  Every required step is complete. Finishing the wizard removes the setup prompt
                  from the admin home.
                </Text>
                <InlineStack>
                  <Button
                    variant="primary"
                    onClick={() => void act('/admin/onboarding/finish')}
                    loading={busy}
                  >
                    Finish setup
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}

interface StepCardProps {
  id: StepId;
  state: StepState;
  isCurrent: boolean;
  skippable: boolean;
  busy: boolean;
  workerBase: string;
  call: (path: string, body?: object) => Promise<Response>;
  act: (path: string, body?: object) => Promise<unknown>;
}

function StepCard(props: StepCardProps) {
  const { id, state, isCurrent, skippable, busy, act } = props;
  const badge = state.done ? (
    <Badge tone="success">Done</Badge>
  ) : state.skipped ? (
    <Badge>Skipped</Badge>
  ) : isCurrent ? (
    <Badge tone="info">In progress</Badge>
  ) : (
    <Badge>Not started</Badge>
  );

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">{STEP_TITLES[id]}</Text>
          {badge}
        </InlineStack>
        <Divider />
        <StepBody {...props} />
        {skippable && !state.done && !state.skipped && (
          <InlineStack>
            <Button
              onClick={() => void act(`/admin/onboarding/step/${id}/skip`)}
              loading={busy}
            >
              Skip this step
            </Button>
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}

function StepBody({ id, state, busy, act, call }: StepCardProps) {
  switch (id) {
    case 'detect':
      return <DetectStep state={state} busy={busy} act={act} />;
    case 'tiers':
      return <LinkStep
        state={state}
        busy={busy}
        act={act}
        url="/tiers"
        body="Create at least one discount tier so the cart-transform Function has somewhere to map Companies. The default ‘Standard wholesale’ tier with a 20% discount works for most pilots."
        completeCta="I've created my tiers"
        stepId="tiers"
      />;
    case 'application':
      return <LinkStep
        state={state}
        busy={busy}
        act={act}
        url="/settings"
        body="Configure the registration form fields, brand colours, and email templates merchants will see when a buyer applies for an account."
        completeCta="My form is ready"
        stepId="application"
      />;
    case 'assets':
      return <LinkStep
        state={state}
        busy={busy}
        act={act}
        url="/assets"
        body="Upload your first catalog, price list, or product imagery so approved dealers have something to download on day one. Skip this step if you'd rather come back to it later."
        completeCta="My library is bootstrapped"
        stepId="assets"
      />;
    case 'test_buyer':
      return <TestBuyerStep state={state} busy={busy} act={act} call={call} />;
    case 'go_live':
      return <GoLiveStep state={state} busy={busy} act={act} />;
  }
}

function DetectStep({
  state,
  busy,
  act,
}: {
  state: StepState;
  busy: boolean;
  act: (path: string, body?: object) => Promise<unknown>;
}) {
  const detected = state.data?.detected as DetectedSetup | undefined;

  return (
    <BlockStack gap="200">
      <Text as="p">
        We'll query your shop for existing Companies, Catalogs, Markets, and customers tagged
        <code> wholesale</code>. Nothing is changed — this is read-only.
      </Text>
      {detected && (
        <Box padding="300" background="bg-surface-secondary" borderRadius="200">
          <List type="bullet">
            <List.Item>Companies: <strong>{detected.companies}</strong></List.Item>
            <List.Item>
              Catalogs: <strong>{detected.catalogs === null ? 'unknown (older API)' : detected.catalogs}</strong>
            </List.Item>
            <List.Item>Markets: <strong>{detected.markets}</strong></List.Item>
            <List.Item>
              Customers tagged <code>wholesale</code>: <strong>{detected.wholesale_tagged_customers}</strong>
            </List.Item>
          </List>
        </Box>
      )}
      <InlineStack>
        <Button
          variant="primary"
          onClick={() => void act('/admin/onboarding/detect')}
          loading={busy}
        >
          {state.done ? 'Re-scan' : 'Scan now'}
        </Button>
      </InlineStack>
    </BlockStack>
  );
}

function LinkStep({
  state,
  busy,
  act,
  url,
  body,
  completeCta,
  stepId,
}: {
  state: StepState;
  busy: boolean;
  act: (path: string, body?: object) => Promise<unknown>;
  url: string;
  body: string;
  completeCta: string;
  stepId: StepId;
}) {
  return (
    <BlockStack gap="200">
      <Text as="p">{body}</Text>
      <InlineStack gap="200">
        <Button url={url}>Open page</Button>
        {!state.done && (
          <Button
            variant="primary"
            onClick={() => void act(`/admin/onboarding/step/${stepId}/complete`)}
            loading={busy}
          >
            {completeCta}
          </Button>
        )}
      </InlineStack>
    </BlockStack>
  );
}

function TestBuyerStep({
  state,
  busy,
  act,
  call,
}: {
  state: StepState;
  busy: boolean;
  act: (path: string, body?: object) => Promise<unknown>;
  call: (path: string, body?: object) => Promise<Response>;
}) {
  const data = (state.data ?? {}) as TestBuyerData;
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState<string | null>(null);

  const resend = useCallback(async () => {
    if (!data.customer_id) return;
    setResending(true);
    setResendMsg(null);
    try {
      const res = await call(`/admin/onboarding/test-buyer/${encodeURIComponent(data.customer_id)}/invite`, {});
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setResendMsg(res.ok ? 'Magic link resent.' : (j.error ?? `failed ${res.status}`));
    } finally {
      setResending(false);
    }
  }, [call, data.customer_id]);

  return (
    <BlockStack gap="200">
      <Text as="p">
        Creates a Shopify Customer + Company you can sign in as to verify the buyer experience.
        Email follows the catch-all pattern {' '}
        <code>test-buyer+&lt;shop&gt;@&lt;your-domain&gt;</code> so it always reaches your inbox.
      </Text>
      {state.done && data.customer_id ? (
        <Box padding="300" background="bg-surface-secondary" borderRadius="200">
          <BlockStack gap="100">
            <Text as="p">
              <strong>Email:</strong> <code>{data.email}</code>
            </Text>
            <Text as="p">
              <strong>Magic link:</strong>{' '}
              {data.invite_sent ? 'Sent on creation.' : `Not sent (${data.invite_reason ?? 'unknown'}).`}
            </Text>
            <InlineStack>
              <Button onClick={resend} loading={resending}>
                Resend magic link
              </Button>
            </InlineStack>
            {resendMsg && <Text as="p" tone="subdued">{resendMsg}</Text>}
          </BlockStack>
        </Box>
      ) : (
        <InlineStack>
          <Button
            variant="primary"
            onClick={() => void act('/admin/onboarding/test-buyer/create')}
            loading={busy}
          >
            Create test buyer
          </Button>
        </InlineStack>
      )}
    </BlockStack>
  );
}

function GoLiveStep({
  state,
  busy,
  act,
}: {
  state: StepState;
  busy: boolean;
  act: (path: string, body?: object) => Promise<unknown>;
}) {
  return (
    <BlockStack gap="200">
      <Text as="p">Before you announce the wholesale portal:</Text>
      <List type="bullet">
        <List.Item>Enable the <strong>B2B Tier Price</strong> embed in the theme editor (App embeds panel).</List.Item>
        <List.Item>
          To show tier pricing beyond the product page, turn on <strong>Show tier pricing across the whole store</strong> in <Link url="/settings">Settings → Price display</Link>. It applies to collections, search, the home page, and the cart drawer with no theme edit.
        </List.Item>
        <List.Item>
          If you run a login-gated B2B store, enable <strong>require login</strong> under <strong>Online Store → Preferences → Restrict store access</strong> so prices render on first paint and never show to the public.
        </List.Item>
        <List.Item>
          Add the <strong>B2B Wholesale Application</strong> embed on the page path where buyers will apply, and link to it from your storefront nav.
        </List.Item>
        <List.Item>
          Enable the <strong>B2B Dealer Asset Portal</strong> Customer Account extension and set its <code>worker_base_url</code> setting.
        </List.Item>
        <List.Item>Sign in as your test buyer and verify tier pricing on a collection page and the PDP, the assets page, and a small test order.</List.Item>
      </List>
      {!state.done && (
        <InlineStack>
          <Button
            variant="primary"
            onClick={() => void act('/admin/onboarding/step/go_live/complete')}
            loading={busy}
          >
            I've completed the checklist
          </Button>
        </InlineStack>
      )}
      <Text as="p" tone="subdued">
        Need to come back later? <Link url="/">Return home</Link>. Your progress is saved.
      </Text>
    </BlockStack>
  );
}
