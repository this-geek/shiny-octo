function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string: odd length');
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('Invalid hex string: non-hex characters');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveShopKey(masterKeyHex: string, shopDomain: string): Promise<CryptoKey> {
  const masterKeyBytes = hexToBytes(masterKeyHex);
  const baseKey = await crypto.subtle.importKey('raw', masterKeyBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('b2b-companion-v1'),
      info: new TextEncoder().encode(shopDomain),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encrypt(
  plaintext: string,
  shopDomain: string,
  masterKeyHex: string,
): Promise<string> {
  const key = await deriveShopKey(masterKeyHex, shopDomain);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    new TextEncoder().encode(plaintext),
  );
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return bytesToBase64(result);
}

export async function decrypt(
  encryptedB64: string,
  shopDomain: string,
  masterKeyHex: string,
): Promise<string> {
  const key = await deriveShopKey(masterKeyHex, shopDomain);
  const data = base64ToBytes(encryptedB64);
  if (data.length < 13) throw new Error('Invalid ciphertext');
  const nonce = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
