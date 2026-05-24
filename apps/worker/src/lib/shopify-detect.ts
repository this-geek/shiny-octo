/**
 * Step 1 of the onboarding wizard — detect what the merchant already has set
 * up on Shopify. We report counts only (not row contents) so the wizard can
 * say "you already have 3 Companies, 1 Catalog, and 18 customers tagged
 * `wholesale`" without us mirroring any of that locally.
 *
 * Catalogs query is best-effort — older API versions don't expose the
 * `catalogs` connection; on error we return null and the UI shows "unknown".
 */

interface CountsResponse {
  data?: {
    companies?: { edges: Array<{ node: { id: string } }> };
    catalogs?: { edges: Array<{ node: { id: string } }> };
    markets?: { edges: Array<{ node: { id: string } }> };
    customers?: { edges: Array<{ node: { id: string } }> };
  };
  errors?: Array<{ message: string }>;
}

export interface ShopifyExistingSetup {
  companies: number;
  catalogs: number | null;
  markets: number;
  wholesale_tagged_customers: number;
  fetched_at: number;
}

const SAMPLE_LIMIT = 50;

const QUERY = `query DetectExisting($wholesaleQuery: String!) {
  companies(first: ${SAMPLE_LIMIT}) { edges { node { id } } }
  catalogs(first: ${SAMPLE_LIMIT}) { edges { node { id } } }
  markets(first: ${SAMPLE_LIMIT}) { edges { node { id } } }
  customers(first: ${SAMPLE_LIMIT}, query: $wholesaleQuery) {
    edges { node { id } }
  }
}`;

export async function detectExistingSetup(
  shopDomain: string,
  token: string,
  apiVersion: string,
): Promise<ShopifyExistingSetup> {
  const res = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { wholesaleQuery: 'tag:wholesale' },
      }),
    },
  );
  if (!res.ok) throw new Error(`detect HTTP ${res.status}`);
  const json = (await res.json()) as CountsResponse;
  // We tolerate a `catalogs` field error (older API) but bail on anything else.
  const otherErrors = (json.errors ?? []).filter(e => !/catalogs/i.test(e.message));
  if (otherErrors.length) {
    throw new Error(`detect errors: ${otherErrors.map(e => e.message).join(', ')}`);
  }
  return {
    companies: json.data?.companies?.edges.length ?? 0,
    catalogs:
      json.data?.catalogs?.edges.length ?? (json.errors?.some(e => /catalogs/i.test(e.message)) ? null : 0),
    markets: json.data?.markets?.edges.length ?? 0,
    wholesale_tagged_customers: json.data?.customers?.edges.length ?? 0,
    fetched_at: Math.floor(Date.now() / 1000),
  };
}
