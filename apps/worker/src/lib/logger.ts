type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  shop_id?: number;
  customer_id_hash?: string; // pre-hashed by caller
  [key: string]: unknown;
}

/**
 * Non-cryptographic hash for log correlation only.
 * Callers who need cryptographic hashing must use hashIdAsync.
 */
export function hashId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/**
 * Cryptographic SHA-256 hash for PII correlation.
 * Returns first 8 bytes (16 hex chars) — sufficient for log correlation.
 */
export async function hashIdAsync(id: string): Promise<string> {
  const data = new TextEncoder().encode(id);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function log(level: Level, message: string, fields: LogFields = {}): void {
  const entry = { level, message, ts: Date.now(), ...fields };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
