/**
 * Generic metafieldsSet helper used by both Shop- and Company-scoped writes.
 * Callers supply the owner GID directly; this module does not look anything up.
 */

interface MetafieldsSetInput {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

interface MetafieldsSetResponse {
  data?: {
    metafieldsSet?: {
      metafields?: Array<{ id: string; key: string }>;
      userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export async function setMetafields(
  shopDomain: string,
  token: string,
  apiVersion: string,
  metafields: MetafieldsSetInput[],
): Promise<void> {
  if (metafields.length === 0) return;

  const mutation = `mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key }
      userErrors { field message code }
    }
  }`;

  const res = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query: mutation, variables: { metafields } }),
    },
  );

  if (!res.ok) throw new Error(`metafieldsSet HTTP ${res.status}`);

  const json = (await res.json()) as MetafieldsSetResponse;
  if (json.errors?.length) {
    throw new Error(`metafieldsSet errors: ${json.errors.map(e => e.message).join(', ')}`);
  }
  const userErrors = json.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `metafieldsSet userErrors: ${userErrors.map(e => e.message).join(', ')}`,
    );
  }
}
