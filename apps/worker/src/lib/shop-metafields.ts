import { setMetafields } from './metafields.js';

interface ShopIdResponse {
  data?: { shop?: { id?: string } };
  errors?: Array<{ message: string }>;
}

export async function fetchShopGid(
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
  await setMetafields(shopDomain, token, apiVersion, [
    { ownerId: shopGid, namespace, key, type, value },
  ]);
}
