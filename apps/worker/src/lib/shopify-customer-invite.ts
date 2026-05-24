/**
 * Send a Shopify customer account invite (the magic-link welcome).
 *
 * Per DECISIONS #7 we use magic-link login only — no password set. Shopify's
 * `customerSendAccountInviteEmail` mutation works for both classic and the
 * new Customer Accounts, and the email is branded by the merchant's email
 * sending config (no extra template work on our side).
 *
 * Used by:
 *   - Phase 1E approve flow — sends the welcome after companyCreate
 *   - Phase 1I onboarding Step 6 — sends to the merchant's test buyer
 *
 * Idempotent on Shopify's side: sending twice just re-issues a fresh
 * magic-link email and counts the contact as "invited" once.
 *
 * https://shopify.dev/docs/api/admin-graphql/latest/mutations/customerSendAccountInviteEmail
 */

export class CustomerInviteError extends Error {
  constructor(
    message: string,
    readonly userErrors: Array<{ field?: string[]; message: string; code?: string }> = [],
  ) {
    super(message);
  }
}

interface InvitePayload {
  data?: {
    customerSendAccountInviteEmail?: {
      customer?: { id: string };
      customerUserErrors?: Array<{ field?: string[]; message: string; code?: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

const MUTATION = `mutation CustomerSendInvite($customerId: ID!) {
  customerSendAccountInviteEmail(customerId: $customerId) {
    customer { id }
    customerUserErrors { field message code }
  }
}`;

export async function sendCustomerInvite(
  shopDomain: string,
  token: string,
  apiVersion: string,
  customerId: string,
): Promise<{ customerId: string }> {
  if (!customerId.startsWith('gid://')) {
    throw new CustomerInviteError('customerId must be a Shopify GID');
  }
  const res = await fetch(
    `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query: MUTATION, variables: { customerId } }),
    },
  );
  if (!res.ok) throw new CustomerInviteError(`HTTP ${res.status}`);
  const json = (await res.json()) as InvitePayload;
  if (json.errors?.length) {
    throw new CustomerInviteError(json.errors.map(e => e.message).join(', '));
  }
  const result = json.data?.customerSendAccountInviteEmail;
  const userErrors = result?.customerUserErrors ?? [];
  if (userErrors.length) {
    throw new CustomerInviteError(userErrors[0].message, userErrors);
  }
  const returnedId = result?.customer?.id;
  if (!returnedId) throw new CustomerInviteError('customerSendAccountInviteEmail returned no customer');
  return { customerId: returnedId };
}
