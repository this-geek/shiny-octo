import { describe, it, expect, beforeAll, vi } from 'vitest';
import { OpsAccessError, verifyAccessJwt } from './cf-access.js';

const TEAM = 'acme';
const AUD = 'a'.repeat(64);
const NOW = 1_700_000_000;

interface KeyPair {
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
  kid: string;
}

async function makeKeyPair(kid: string): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { publicJwk, privateKey: pair.privateKey, kid };
}

function b64url(bytes: Uint8Array | string): string {
  const buf =
    typeof bytes === 'string'
      ? new TextEncoder().encode(bytes)
      : bytes;
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function signJwt(
  pk: CryptoKey,
  kid: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    pk,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
    async delete(k: string) {
      store.delete(k);
    },
  } as unknown as KVNamespace;
}

let keyPair: KeyPair;

beforeAll(async () => {
  keyPair = await makeKeyPair('test-kid-1');
});

function mockJwks(pair: KeyPair): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    expect(url).toContain(`${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
    return new Response(
      JSON.stringify({
        keys: [
          {
            kty: pair.publicJwk.kty,
            kid: pair.kid,
            n: pair.publicJwk.n,
            e: pair.publicJwk.e,
            alg: 'RS256',
            use: 'sig',
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

describe('cf-access: verifyAccessJwt', () => {
  it('accepts a valid token and returns the email claim', async () => {
    mockJwks(keyPair);
    const token = await signJwt(keyPair.privateKey, keyPair.kid, {
      aud: AUD,
      email: 'op@example.com',
      sub: 'user-1',
      iss: `https://${TEAM}.cloudflareaccess.com`,
      iat: NOW - 10,
      exp: NOW + 300,
    });
    const identity = await verifyAccessJwt({
      token,
      team: TEAM,
      expectedAud: AUD,
      kv: fakeKv(),
      now: NOW,
    });
    expect(identity).toEqual({ email: 'op@example.com', sub: 'user-1' });
  });

  it('rejects an expired token', async () => {
    mockJwks(keyPair);
    const token = await signJwt(keyPair.privateKey, keyPair.kid, {
      aud: AUD,
      email: 'op@example.com',
      sub: 'user-1',
      iss: `https://${TEAM}.cloudflareaccess.com`,
      iat: NOW - 3600,
      exp: NOW - 60,
    });
    await expect(
      verifyAccessJwt({ token, team: TEAM, expectedAud: AUD, kv: fakeKv(), now: NOW }),
    ).rejects.toBeInstanceOf(OpsAccessError);
  });

  it('rejects an audience mismatch', async () => {
    mockJwks(keyPair);
    const token = await signJwt(keyPair.privateKey, keyPair.kid, {
      aud: 'other-aud',
      email: 'op@example.com',
      sub: 'user-1',
      iss: `https://${TEAM}.cloudflareaccess.com`,
      iat: NOW - 10,
      exp: NOW + 300,
    });
    await expect(
      verifyAccessJwt({ token, team: TEAM, expectedAud: AUD, kv: fakeKv(), now: NOW }),
    ).rejects.toThrow(/Audience mismatch/);
  });

  it('rejects an issuer mismatch', async () => {
    mockJwks(keyPair);
    const token = await signJwt(keyPair.privateKey, keyPair.kid, {
      aud: AUD,
      email: 'op@example.com',
      sub: 'user-1',
      iss: 'https://impostor.cloudflareaccess.com',
      iat: NOW - 10,
      exp: NOW + 300,
    });
    await expect(
      verifyAccessJwt({ token, team: TEAM, expectedAud: AUD, kv: fakeKv(), now: NOW }),
    ).rejects.toThrow(/Unexpected iss/);
  });

  it('rejects a signature signed by the wrong key', async () => {
    const evilPair = await makeKeyPair('test-kid-1');
    mockJwks(keyPair); // JWKS returns the real key; token signed by impostor
    const token = await signJwt(evilPair.privateKey, keyPair.kid, {
      aud: AUD,
      email: 'op@example.com',
      sub: 'user-1',
      iss: `https://${TEAM}.cloudflareaccess.com`,
      iat: NOW - 10,
      exp: NOW + 300,
    });
    await expect(
      verifyAccessJwt({ token, team: TEAM, expectedAud: AUD, kv: fakeKv(), now: NOW }),
    ).rejects.toThrow(/Invalid JWT signature/);
  });

  it('rejects an unknown kid', async () => {
    mockJwks(keyPair);
    const token = await signJwt(keyPair.privateKey, 'unknown-kid', {
      aud: AUD,
      email: 'op@example.com',
      sub: 'user-1',
      iss: `https://${TEAM}.cloudflareaccess.com`,
      iat: NOW - 10,
      exp: NOW + 300,
    });
    await expect(
      verifyAccessJwt({ token, team: TEAM, expectedAud: AUD, kv: fakeKv(), now: NOW }),
    ).rejects.toThrow(/No JWKS key for kid/);
  });

  it('rejects a non-RS256 alg (e.g. alg=none downgrade)', async () => {
    mockJwks(keyPair);
    const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: keyPair.kid }));
    const body = b64url(
      JSON.stringify({
        aud: AUD,
        email: 'op@example.com',
        sub: 'user-1',
        iss: `https://${TEAM}.cloudflareaccess.com`,
        iat: NOW - 10,
        exp: NOW + 300,
      }),
    );
    const token = `${header}.${body}.`;
    await expect(
      verifyAccessJwt({ token, team: TEAM, expectedAud: AUD, kv: fakeKv(), now: NOW }),
    ).rejects.toThrow(/Unsupported alg/);
  });

  it('caches JWKS responses across calls within the same KV', async () => {
    mockJwks(keyPair);
    const kv = fakeKv();
    const token = await signJwt(keyPair.privateKey, keyPair.kid, {
      aud: AUD,
      email: 'op@example.com',
      sub: 'user-1',
      iss: `https://${TEAM}.cloudflareaccess.com`,
      iat: NOW - 10,
      exp: NOW + 300,
    });
    await verifyAccessJwt({ token, team: TEAM, expectedAud: AUD, kv, now: NOW });
    await verifyAccessJwt({ token, team: TEAM, expectedAud: AUD, kv, now: NOW });
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
