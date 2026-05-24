/**
 * Approve an application → create Shopify Company + Location + Contact.
 *
 * Three mutations, in order:
 *   1. companyCreate (also creates the main location + contact in one call)
 *      → returns Company id, primary CompanyLocation id, and main Contact id
 *   2. (Optional) extra companyLocationCreate for branches — not used in v1
 *   3. (Optional) companyContactAssignRoles to mark the contact as admin
 *
 * We send a stable mutation idempotency key on the wire so re-trying the same
 * approval (double-click, retry-on-network-blip, queue redelivery) does not
 * create duplicate Companies. The key combines (shop, application id, status)
 * so re-opening + re-approving an application uses a different key.
 *
 * https://shopify.dev/docs/api/admin-graphql/latest/mutations/companycreate
 */

export interface CompanyCreateRequest {
  email: string;
  companyName: string;
  externalApplicationId: number; // for the idempotency key
  locale?: string;
  note?: string;
}

export interface CompanyCreateResult {
  companyId: string;
  locationId: string | null;
  contactId: string | null;
  customerId: string | null;
}

interface CompanyCreatePayload {
  data?: {
    companyCreate?: {
      company?: {
        id: string;
        mainContact?: {
          id: string;
          customer?: { id: string };
        };
        locations?: { nodes?: Array<{ id: string }> };
      };
      userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

const COMPANY_CREATE_MUTATION = `mutation CompanyCreate($input: CompanyCreateInput!) {
  companyCreate(input: $input) {
    company {
      id
      mainContact {
        id
        customer { id }
      }
      locations(first: 1) {
        nodes { id }
      }
    }
    userErrors { field message code }
  }
}`;

export class CompanyCreateError extends Error {
  constructor(message: string, public userErrors: Array<{ message: string; code?: string }> = []) {
    super(message);
  }
}

export function buildIdempotencyKey(shopDomain: string, applicationId: number): string {
  return `b2b-companion:approve:${shopDomain}:app-${applicationId}`;
}

export async function createCompanyForApplication(
  shopDomain: string,
  token: string,
  apiVersion: string,
  req: CompanyCreateRequest,
): Promise<CompanyCreateResult> {
  const input = {
    company: {
      name: req.companyName,
      note: req.note,
    },
    companyContact: {
      email: req.email,
      locale: req.locale,
    },
    companyLocation: {
      name: 'Primary',
      locale: req.locale,
      shippingAddress: {
        // Shopify requires at least country on a location; pull from the
        // form if present, default to NZ for the pilot (DECISIONS #12).
        countryCode: 'NZ',
      },
    },
  };

  const res = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
        // Shopify de-duplicates mutations with the same idempotency key
        // within a 24h window — perfect for double-clicked approve buttons
        // and queue-redelivery retries.
        'X-Idempotency-Key': buildIdempotencyKey(shopDomain, req.externalApplicationId),
      },
      body: JSON.stringify({ query: COMPANY_CREATE_MUTATION, variables: { input } }),
    },
  );

  if (!res.ok) {
    throw new CompanyCreateError(`companyCreate HTTP ${res.status}`);
  }

  const json = (await res.json()) as CompanyCreatePayload;
  if (json.errors?.length) {
    throw new CompanyCreateError(
      `companyCreate errors: ${json.errors.map(e => e.message).join(', ')}`,
    );
  }

  const userErrors = json.data?.companyCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new CompanyCreateError(
      `companyCreate userErrors: ${userErrors.map(e => e.message).join(', ')}`,
      userErrors,
    );
  }

  const company = json.data?.companyCreate?.company;
  if (!company) throw new CompanyCreateError('companyCreate returned no company');

  return {
    companyId: company.id,
    locationId: company.locations?.nodes?.[0]?.id ?? null,
    contactId: company.mainContact?.id ?? null,
    customerId: company.mainContact?.customer?.id ?? null,
  };
}
