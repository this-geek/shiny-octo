/**
 * Cloudflare Access JWT verifier.
 *
 * `/_ops/*` sits behind a Cloudflare Access (Zero Trust) application. CF
 * Access proxies authenticated requests to the Worker with a signed JWT
 * in the `Cf-Access-Jwt-Assertion` header. We verify the signature
 * against the team's JWKS so an attacker who finds the Worker URL
 * cannot bypass Access by hitting it directly with a forged email
 * header.
 *
 * Two env vars are required:
 *   OPS_ACCESS_TEAM — your CF team domain prefix
 *                     (e.g. `acme` for `acme.cloudflareaccess.com`)
 *   OPS_ACCESS_AUD  — the Application Audience tag from the Access
 *                     dashboard (a long hex string)
 *
 * If either is unset, every request to `/_ops/*` is refused. We do not
 * fall back to header trust — that's the bypass we exist to prevent.
 *
 * Reference:
 *   https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */

const JWKS_CACHE_KEY = 'cf_access:jwks';
const JWKS_CACHE_TTL = 600; // 10 minutes

export class OpsAccessError extends Error {}

interface CfJwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

interface CfJwks {
  keys: CfJwk[];
}

interface CfAccessClaims {
  aud: string | string[];
  email: string;
  exp: number;
  iat: number;
  iss: string;
  sub: string;
  identity_nonce?: string;
  country?: string;
}

export interface AccessIdentity {
  email: string;
  sub: string;
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  const b64 = pad ? padded + '='.repeat(4 - pad) : padded;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function fetchJwks(team: string, kv: KVNamespace): Promise<CfJwks> {
  const cached = await kv.get(JWKS_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as CfJwks;
    } catch {
      // fall through and refetch
    }
  }
  const url = `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new OpsAccessError(`JWKS fetch failed: ${res.status}`);
  }
  const json = (await res.json()) as CfJwks;
  if (!json.keys || !Array.isArray(json.keys)) {
    throw new OpsAccessError('JWKS response missing keys array');
  }
  await kv.put(JWKS_CACHE_KEY, JSON.stringify(json), {
    expirationTtl: JWKS_CACHE_TTL,
  });
  return json;
}

async function verifyRs256(
  signingInput: string,
  signatureB64: string,
  jwk: CfJwk,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      alg: 'RS256',
      ext: true,
    },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signature = base64UrlDecode(signatureB64);
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature,
    new TextEncoder().encode(signingInput),
  );
}

export interface VerifyArgs {
  token: string;
  team: string;
  expectedAud: string;
  kv: KVNamespace;
  now?: number;
}

export async function verifyAccessJwt(args: VerifyArgs): Promise<AccessIdentity> {
  const { token, team, expectedAud, kv } = args;
  const nowSecs = args.now ?? Math.floor(Date.now() / 1000);

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new OpsAccessError('Invalid JWT structure');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
  } catch {
    throw new OpsAccessError('Invalid JWT header');
  }
  if (header.alg !== 'RS256') {
    throw new OpsAccessError(`Unsupported alg: ${header.alg ?? 'none'}`);
  }
  if (!header.kid) {
    throw new OpsAccessError('JWT header missing kid');
  }

  const jwks = await fetchJwks(team, kv);
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) {
    throw new OpsAccessError(`No JWKS key for kid=${header.kid}`);
  }

  const ok = await verifyRs256(`${headerB64}.${payloadB64}`, signatureB64, jwk);
  if (!ok) {
    throw new OpsAccessError('Invalid JWT signature');
  }

  let claims: CfAccessClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as CfAccessClaims;
  } catch {
    throw new OpsAccessError('Invalid JWT payload');
  }

  if (claims.exp < nowSecs) throw new OpsAccessError('JWT expired');
  if (claims.iat > nowSecs + 10) throw new OpsAccessError('JWT issued in future');

  const expectedIss = `https://${team}.cloudflareaccess.com`;
  if (claims.iss !== expectedIss) {
    throw new OpsAccessError(`Unexpected iss: ${claims.iss}`);
  }

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(expectedAud)) {
    throw new OpsAccessError('Audience mismatch');
  }

  if (!claims.email || typeof claims.email !== 'string') {
    throw new OpsAccessError('JWT missing email claim');
  }

  return { email: claims.email, sub: claims.sub };
}
