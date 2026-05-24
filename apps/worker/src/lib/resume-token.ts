/**
 * Signed resume tokens for wholesale application drafts.
 *
 * Token format: `base64url(JSON.stringify(payload)).hex(HMAC-SHA256(payload))`
 * Payload: { aid: number, email: string, exp: number }
 *
 * - aid:   application id the token unlocks
 * - email: scoped so a leaked token cannot resume a different applicant's draft
 * - exp:   seconds-since-epoch; 14-day TTL per PLAN.md 1E
 *
 * Stateless: no DB write per autosave call. To "revoke" a token (e.g. once
 * the application is submitted) we check `applications.status` at use time —
 * resume is only allowed against draft / needs_info rows.
 *
 * Signed with the per-shop HKDF subkey of MASTER_KEY so a leaked token from
 * shop A is useless against shop B even if the same email exists in both.
 */

const TTL_SECONDS = 14 * 24 * 60 * 60;

export interface ResumeTokenPayload {
  aid: number;
  email: string;
  exp: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string: odd length');
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('Invalid hex string: non-hex characters');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Derive a per-shop HMAC secret deterministically via HKDF over the master
 * key, scoped to the shop domain. Two shops with the same master key get
 * different secrets, so a leaked token from shop A is useless against shop B.
 */
async function deriveHmacSecret(masterKeyHex: string, shopDomain: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(masterKeyHex),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('b2b-companion-resume-token-v1'),
      info: new TextEncoder().encode(shopDomain),
    },
    baseKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

async function hmacSign(message: string, key: CryptoKey): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signResumeToken(
  applicationId: number,
  email: string,
  shopDomain: string,
  masterKeyHex: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: ResumeTokenPayload = {
    aid: applicationId,
    email: email.toLowerCase(),
    exp: now + TTL_SECONDS,
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payloadStr));
  const secret = await deriveHmacSecret(masterKeyHex, shopDomain);
  const sig = await hmacSign(payloadB64, secret);
  return `${payloadB64}.${toHex(sig)}`;
}

export class ResumeTokenError extends Error {}

export async function verifyResumeToken(
  token: string,
  shopDomain: string,
  masterKeyHex: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ResumeTokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 2) throw new ResumeTokenError('malformed token');
  const [payloadB64, sigHex] = parts;

  let providedSig: Uint8Array;
  try {
    providedSig = fromHex(sigHex);
  } catch {
    throw new ResumeTokenError('malformed signature');
  }

  const secret = await deriveHmacSecret(masterKeyHex, shopDomain);
  const expectedSig = await hmacSign(payloadB64, secret);
  if (!timingSafeEqualBytes(providedSig, expectedSig)) {
    throw new ResumeTokenError('bad signature');
  }

  let payload: ResumeTokenPayload;
  try {
    const json = new TextDecoder().decode(base64UrlDecode(payloadB64));
    payload = JSON.parse(json) as ResumeTokenPayload;
  } catch {
    throw new ResumeTokenError('malformed payload');
  }

  if (
    typeof payload.aid !== 'number' ||
    typeof payload.email !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    throw new ResumeTokenError('payload missing fields');
  }
  if (payload.exp <= now) throw new ResumeTokenError('expired');
  return payload;
}

