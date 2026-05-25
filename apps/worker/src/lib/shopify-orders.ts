/**
 * Activity probe for activation nudges (Phase 1J).
 *
 * The cron handler asks Shopify whether a buyer has placed any order since
 * their wholesale account was approved. If they have, we skip the nudge.
 *
 * One GraphQL roundtrip per candidate per day per shop. At pilot scale this
 * is fine; for App Store scale we'd cache the answer in KV with a short TTL,
 * or drive it from `orders/create` webhooks instead.
 */

interface OrdersAfterResp {
  data?: {
    orders?: {
      edges?: Array<{ node: { id: string } }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export async function hasOrderSince(
  shopDomain: string,
  token: string,
  apiVersion: string,
  customerGid: string,
  sinceEpochSeconds: number,
): Promise<boolean> {
  // Shopify search wants ISO 8601 — `created_at:>=YYYY-MM-DDThh:mm:ssZ`.
  const sinceIso = new Date(sinceEpochSeconds * 1000).toISOString();
  const numericId = customerGid.startsWith('gid://')
    ? customerGid.split('/').pop()
    : customerGid;
  const query = `query ActivityProbe($q: String!) {
    orders(first: 1, query: $q) { edges { node { id } } }
  }`;
  const search = `customer_id:${numericId} AND created_at:>='${sinceIso}'`;
  const res = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables: { q: search } }),
    },
  );
  if (!res.ok) throw new Error(`orders probe HTTP ${res.status}`);
  const json = (await res.json()) as OrdersAfterResp;
  if (json.errors?.length) {
    throw new Error(`orders probe errors: ${json.errors.map(e => e.message).join(', ')}`);
  }
  return (json.data?.orders?.edges?.length ?? 0) > 0;
}
