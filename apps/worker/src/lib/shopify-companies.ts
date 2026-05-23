/**
 * Lists Shopify Companies via Admin GraphQL for the company-tier mapping UI.
 *
 * Shopify enforces a 250-per-page cap on `companies(first: N)`. We paginate
 * with `endCursor` until `hasNextPage` is false, capped at MAX_COMPANIES so
 * a runaway B2B shop can't OOM the Worker. If we hit the cap we stop and
 * mark the result as truncated; the admin UI surfaces that to the merchant.
 */

export interface ShopifyCompanySummary {
  id: string;
  name: string;
  externalId: string | null;
  locationsCount: number | null;
}

export interface ShopifyCompaniesResult {
  companies: ShopifyCompanySummary[];
  truncated: boolean;
}

const PAGE_SIZE = 100;
const MAX_COMPANIES = 1000;

const QUERY = `query ListCompanies($cursor: String) {
  companies(first: ${PAGE_SIZE}, after: $cursor, sortKey: NAME) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        name
        externalId
        locationsCount { count }
      }
    }
  }
}`;

interface GraphQLResponse {
  data?: {
    companies?: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{
        node: {
          id: string;
          name: string;
          externalId: string | null;
          locationsCount: { count: number } | null;
        };
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export async function listShopifyCompanies(
  shopDomain: string,
  token: string,
  apiVersion: string,
): Promise<ShopifyCompaniesResult> {
  const all: ShopifyCompanySummary[] = [];
  let cursor: string | null = null;

  while (all.length < MAX_COMPANIES) {
    const res = await fetch(
      `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query: QUERY, variables: { cursor } }),
      },
    );

    if (!res.ok) throw new Error(`listShopifyCompanies HTTP ${res.status}`);

    const json = (await res.json()) as GraphQLResponse;
    if (json.errors?.length) {
      throw new Error(
        `listShopifyCompanies errors: ${json.errors.map(e => e.message).join(', ')}`,
      );
    }

    const page = json.data?.companies;
    if (!page) break;

    for (const edge of page.edges) {
      all.push({
        id: edge.node.id,
        name: edge.node.name,
        externalId: edge.node.externalId,
        locationsCount: edge.node.locationsCount?.count ?? null,
      });
      if (all.length >= MAX_COMPANIES) break;
    }

    if (!page.pageInfo.hasNextPage) {
      return { companies: all, truncated: false };
    }
    cursor = page.pageInfo.endCursor;
    if (!cursor) break;
  }

  return { companies: all, truncated: all.length >= MAX_COMPANIES };
}
