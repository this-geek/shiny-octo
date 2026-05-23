export interface MetafieldDefinitionSpec {
  namespace: string;
  key: string;
  type: string;
  name: string;
  description: string;
  ownerType: 'PRODUCT' | 'COMPANY' | 'ORDER' | 'SHOP';
}

export const B2B_METAFIELD_DEFINITIONS: MetafieldDefinitionSpec[] = [
  {
    namespace: 'b2b',
    key: 'b2b_only',
    type: 'boolean',
    ownerType: 'PRODUCT',
    name: 'B2B Only',
    description: 'Hide from non-B2B customers',
  },
  {
    namespace: 'b2b',
    key: 'case_quantity',
    type: 'number_integer',
    ownerType: 'PRODUCT',
    name: 'Case Quantity',
    description: 'Step quantity for B2B orders',
  },
  {
    namespace: 'b2b',
    key: 'min_order_qty',
    type: 'number_integer',
    ownerType: 'PRODUCT',
    name: 'Min Order Qty',
    description: 'Per-line minimum quantity',
  },
  {
    namespace: 'b2b',
    key: 'max_order_qty',
    type: 'number_integer',
    ownerType: 'PRODUCT',
    name: 'Max Order Qty',
    description: 'Per-line maximum quantity',
  },
  {
    namespace: 'b2b',
    key: 'tier_id',
    type: 'number_integer',
    ownerType: 'COMPANY',
    name: 'B2B Tier ID',
    description: 'Mirror of our tier mapping',
  },
  {
    namespace: 'b2b',
    key: 'is_plus',
    type: 'boolean',
    ownerType: 'SHOP',
    name: 'B2B Companion: Plus shop',
    description: 'True when shop is Shopify Plus',
  },
  {
    namespace: 'b2b',
    key: 'app_proxy_path',
    type: 'single_line_text_field',
    ownerType: 'SHOP',
    name: 'B2B Companion: App Proxy Path',
    description: 'Configured App Proxy prefix/subpath, e.g. "apps/b2b"',
  },
  {
    namespace: 'b2b',
    key: 'tiers_config',
    type: 'json',
    ownerType: 'SHOP',
    name: 'B2B Companion: Tiers config',
    description: 'Full tier set serialised for cart-transform / cart-validation Functions.',
  },
];

interface DefinitionCreateResponse {
  data?: {
    metafieldDefinitionCreate?: {
      createdDefinition?: { id: string } | null;
      userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

async function createDefinition(
  shopDomain: string,
  token: string,
  apiVersion: string,
  spec: MetafieldDefinitionSpec,
): Promise<void> {
  const mutation = `mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
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
          definition: {
            namespace: spec.namespace,
            key: spec.key,
            type: spec.type,
            name: spec.name,
            description: spec.description,
            ownerType: spec.ownerType,
          },
        },
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`metafieldDefinitionCreate HTTP ${res.status} for ${spec.namespace}.${spec.key}`);
  }

  const json = (await res.json()) as DefinitionCreateResponse;
  if (json.errors?.length) {
    throw new Error(
      `metafieldDefinitionCreate errors for ${spec.namespace}.${spec.key}: ${json.errors.map(e => e.message).join(', ')}`,
    );
  }
  const userErrors = json.data?.metafieldDefinitionCreate?.userErrors ?? [];
  // TAKEN means the definition already exists — idempotent no-op.
  const blocking = userErrors.filter(e => e.code !== 'TAKEN');
  if (blocking.length > 0) {
    throw new Error(
      `metafieldDefinitionCreate userErrors for ${spec.namespace}.${spec.key}: ${blocking
        .map(e => e.message)
        .join(', ')}`,
    );
  }
}

export async function ensureMetafieldDefinitions(
  shopDomain: string,
  token: string,
  apiVersion: string,
): Promise<void> {
  for (const spec of B2B_METAFIELD_DEFINITIONS) {
    await createDefinition(shopDomain, token, apiVersion, spec);
  }
}
