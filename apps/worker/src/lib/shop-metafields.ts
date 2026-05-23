interface ShopIdResponse {
  data?: { shop?: { id?: string } };
  errors?: Array<{ message: string }>;
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

async function fetchShopGid(
  shopDomain: string,
  token: string,
  apiVersion: string,
): Promise<string> {
  const res = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query: '{ shop { id } }' }),
    },
  );
  if (!res.ok) throw new Error(`Shop GID query failed: ${res.status}`);
  const json = (await res.json()) as ShopIdResponse;
  if (json.errors?.length) {
    throw new Error(`Shop GID errors: ${json.errors.map(e => e.message).join(', ')}`);
  }
  const id = json.data?.shop?.id;
  if (!id) throw new Error('Shop GID missing from response');
  return id;
}

/**
 * Write a Shop-scoped metafield via the metafieldsSet mutation.
 * Functions cannot query D1, so we mirror state into Shop metafields they can read.
 */
export async function setShopMetafield(
  shopDomain: string,
  token: string,
  apiVersion: string,
  namespace: string,
  key: string,
  type: string,
  value: string,
): Promise<void> {
  const shopGid = await fetchShopGid(shopDomain, token, apiVersion);

  const mutation = `mutation SetShopMetafield($metafields: [MetafieldsSetInput!]!) {
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
      body: JSON.stringify({
        query: mutation,
        variables: {
          metafields: [
            { ownerId: shopGid, namespace, key, type, value },
          ],
        },
      }),
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
