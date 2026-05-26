/**
 * Shopify token exchange — RFC 8693, Shopify-specific token types.
 *
 * Trade a verified App Bridge session token (the JWT the embedded admin
 * already sends with every authenticated request) for a long-lived offline
 * access token. This is the modern alternative to the `/auth/callback`
 * authorization-code dance and is required for managed installation
 * (`use_legacy_install_flow = false`), where Shopify never redirects the
 * merchant through our OAuth callback.
 *
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/use-token-exchange
 */

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
const REQUESTED_OFFLINE_TOKEN_TYPE =
  'urn:shopify:params:oauth:token-type:offline-access-token';

interface TokenExchangeArgs {
  shopDomain: string;
  sessionToken: string;
  clientId: string;
  clientSecret: string;
}

interface TokenExchangeResponse {
  access_token?: string;
  scope?: string;
}

export async function exchangeForOfflineToken({
  shopDomain,
  sessionToken,
  clientId,
  clientSecret,
}: TokenExchangeArgs): Promise<string> {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: GRANT_TYPE,
      subject_token: sessionToken,
      subject_token_type: SUBJECT_TOKEN_TYPE,
      requested_token_type: REQUESTED_OFFLINE_TOKEN_TYPE,
    }),
  });

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`Token exchange failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as TokenExchangeResponse;
  if (!json.access_token) {
    throw new Error('Token exchange response missing access_token');
  }
  return json.access_token;
}
