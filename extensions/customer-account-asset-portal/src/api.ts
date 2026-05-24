/**
 * Thin client for the Worker's /customer-account/* routes.
 *
 * Auth: every call includes the Customer Account session token as a Bearer
 * header. The Worker re-checks visibility on every list/download (see
 * lib/asset-serve.ts) so the client only renders what the server returns.
 *
 * The Worker base URL is injected at build/runtime via Shopify's extension
 * settings (`WORKER_BASE_URL`). We don't hardcode the workers.dev hostname
 * here because each merchant install ultimately points at the same Worker
 * but it might move (custom domain, region pinning, etc.).
 */

export interface AssetItem {
  id: number;
  folder_id: number | null;
  type: 'file' | 'image' | 'video' | 'link';
  title: string;
  description: string | null;
  file_size_bytes: number | null;
  mime_type: string | null;
  external_url: string | null;
  uploaded_at: string;
}

export async function fetchAssets(
  workerBaseUrl: string,
  token: string,
): Promise<AssetItem[]> {
  const res = await fetch(`${workerBaseUrl.replace(/\/$/, '')}/customer-account/assets/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`assets/list ${res.status}`);
  const json = (await res.json()) as { assets: AssetItem[] };
  return json.assets ?? [];
}

export async function downloadAsset(
  workerBaseUrl: string,
  token: string,
  assetId: number,
): Promise<{ kind: 'link'; url: string } | { kind: 'blob'; blob: Blob; filename: string }> {
  const res = await fetch(
    `${workerBaseUrl.replace(/\/$/, '')}/customer-account/assets/download/${assetId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    if (res.status === 429) throw new Error('monthly download limit reached');
    throw new Error(`download ${res.status}`);
  }
  const ct = res.headers.get('Content-Type') ?? '';
  if (ct.includes('application/json')) {
    const j = (await res.json()) as { url: string };
    return { kind: 'link', url: j.url };
  }
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(cd);
  const filename = match ? decodeURIComponent(match[1]) : `asset-${assetId}`;
  return { kind: 'blob', blob: await res.blob(), filename };
}
