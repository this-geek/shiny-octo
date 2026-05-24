/**
 * Thin wrapper over the R2 multipart binding API.
 *
 * We expose a session-id (random) to the admin client so it never sees the
 * underlying R2 uploadId/key. Sessions are tracked in KV so the same Worker
 * (or any other instance) can resume a multipart on subsequent part uploads.
 *
 * Session record (KV value, JSON):
 *   { shop_id, asset_id_pending: null, key, upload_id, created_at }
 *
 * Per-part PUTs route through the Worker (browser → /admin/assets/uploads/:id/parts/:n
 * → Worker streams the body to R2 via R2MultipartUpload.uploadPart). Each part
 * must be ≤ ~95MB to stay under the Worker request-body cap. The client
 * chunks the file and uploads parts sequentially or in parallel.
 *
 * Note: this routes the bytes through the Worker. If R2 ingress turns out to
 * be a bottleneck at pilot scale we can swap this for S3-SigV4 presigned
 * part URLs (requires R2 access-key secrets + Worker-side SigV4 signing),
 * but the binding-driven path is simpler and needs no extra credentials.
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24h — must finish multipart within a day

export interface UploadSession {
  shop_id: number;
  key: string;
  upload_id: string;
  filename: string;
  mime_type: string;
  total_size_bytes: number;
  created_at: number;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export function sessionKvKey(shopId: number, sessionId: string): string {
  return `upload:${shopId}:${sessionId}`;
}

export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export async function saveSession(
  kv: KVNamespace,
  sessionId: string,
  session: UploadSession,
): Promise<void> {
  await kv.put(sessionKvKey(session.shop_id, sessionId), JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function loadSession(
  kv: KVNamespace,
  shopId: number,
  sessionId: string,
): Promise<UploadSession | null> {
  const raw = await kv.get(sessionKvKey(shopId, sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UploadSession;
  } catch {
    return null;
  }
}

export async function deleteSession(
  kv: KVNamespace,
  shopId: number,
  sessionId: string,
): Promise<void> {
  await kv.delete(sessionKvKey(shopId, sessionId));
}
