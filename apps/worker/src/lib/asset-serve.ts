import type { Env } from '../types.js';
import { getAsset, logAssetDownload, type Asset } from './asset-store.js';
import { isAssetVisible, listVisibleAssets } from './asset-visibility.js';
import { assertWithinBudget, recordDownload } from './bandwidth-counter.js';
import { assertKeyBelongsToShop } from './r2-keys.js';
import { hashIdAsync, log } from './logger.js';
import type { BuyerCtx } from './buyer-context.js';

/**
 * Asset list + download responses shared by the App Proxy and the Customer
 * Account UI routes. Both surfaces must apply identical visibility +
 * bandwidth checks, so the logic lives here and the routers only differ in
 * how they authenticate the buyer.
 */

export async function buildAssetListResponse(
  env: Env,
  buyer: BuyerCtx,
): Promise<{ assets: Array<Record<string, unknown>> }> {
  if (!buyer.is_b2b) return { assets: [] };
  const assets = await listVisibleAssets(env.DB, buyer);
  const safe = assets.map(a => ({
    id: a.id,
    folder_id: a.folder_id,
    type: a.type,
    title: a.title,
    description: a.description,
    file_size_bytes: a.file_size_bytes,
    mime_type: a.mime_type,
    external_url: a.type === 'link' ? a.external_url : null,
    uploaded_at: a.uploaded_at,
  }));
  return { assets: safe };
}

export type DownloadResult =
  | { kind: 'forbidden' }
  | { kind: 'not_found' }
  | { kind: 'bad_request' }
  | { kind: 'rate_limited' }
  | { kind: 'server_error'; reason: string }
  | { kind: 'link'; url: string }
  | { kind: 'stream'; body: ReadableStream; headers: Headers };

export type AccessCheckResult =
  | { kind: 'forbidden' }
  | { kind: 'not_found' }
  | { kind: 'bad_request' }
  | { kind: 'rate_limited' }
  | { kind: 'server_error'; reason: string }
  | { kind: 'link'; asset: Asset; url: string }
  | { kind: 'stream_ready'; asset: Asset };

/**
 * Run all precondition checks for an asset download without touching R2 or
 * recording the download. Used by the probe endpoint so the portal SPA can
 * surface "forbidden" / "rate limited" toasts before triggering a real
 * navigation that downloads the file.
 *
 * Note on TOCTOU: between probe and the subsequent navigation, the budget
 * could tip over the ceiling. That's acceptable — the streaming endpoint
 * re-runs the same checks and will 429 the navigation if so.
 */
export async function checkAssetDownloadAccess(
  env: Env,
  buyer: BuyerCtx,
  assetIdRaw: string,
): Promise<AccessCheckResult> {
  if (!buyer.is_b2b) return { kind: 'forbidden' };

  const assetId = Number.parseInt(assetIdRaw, 10);
  if (!Number.isInteger(assetId) || assetId <= 0) return { kind: 'bad_request' };

  const asset = await getAsset(env.DB, buyer.shop_id, assetId);
  if (!asset || asset.deleted_at !== null) return { kind: 'not_found' };
  if (!(await isAssetVisible(env.DB, asset, buyer))) return { kind: 'not_found' };

  if (asset.type === 'link') {
    if (!asset.external_url) return { kind: 'server_error', reason: 'missing url' };
    return { kind: 'link', asset, url: asset.external_url };
  }

  const budget = await assertWithinBudget(env.KV_HOT_CACHE, buyer.shop_id);
  if (!budget.withinBudget) {
    log('warn', 'asset download: monthly bandwidth ceiling hit', {
      shop_id: buyer.shop_id,
      used_bytes: budget.usedBytes,
    });
    return { kind: 'rate_limited' };
  }

  if (!asset.r2_key) return { kind: 'server_error', reason: 'asset has no file' };
  assertKeyBelongsToShop(asset.r2_key, buyer.shop_id);

  return { kind: 'stream_ready', asset };
}

export async function buildAssetDownloadResponse(
  env: Env,
  buyer: BuyerCtx,
  assetIdRaw: string,
  clientIp: string | null,
): Promise<DownloadResult> {
  const access = await checkAssetDownloadAccess(env, buyer, assetIdRaw);

  if (access.kind === 'link') {
    await recordDownloadAndLog(env, access.asset, buyer, 0, clientIp);
    return { kind: 'link', url: access.url };
  }
  if (access.kind !== 'stream_ready') return access;

  const asset = access.asset;
  // checkAssetDownloadAccess guarantees r2_key is present for stream_ready.
  const obj = await env.ASSETS_BUCKET.get(asset.r2_key as string);
  if (!obj) return { kind: 'not_found' };

  const bytes = asset.file_size_bytes ?? obj.size ?? 0;
  await recordDownloadAndLog(env, asset, buyer, bytes, clientIp);

  const headers = new Headers();
  if (asset.mime_type) headers.set('Content-Type', asset.mime_type);
  headers.set(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(asset.title)}"`,
  );
  if (bytes) headers.set('Content-Length', String(bytes));
  headers.set('Cache-Control', 'private, no-store');
  return { kind: 'stream', body: obj.body, headers };
}

async function recordDownloadAndLog(
  env: Env,
  asset: Asset,
  buyer: BuyerCtx,
  bytes: number,
  ip: string | null,
): Promise<void> {
  const customerHash = await hashIdAsync(buyer.customer_id);
  const ipHash = await hashIdAsync(ip ? `ip:${ip}` : `cust:${buyer.customer_id}`);
  try {
    await logAssetDownload(
      env.DB,
      buyer.shop_id,
      asset.id,
      buyer.shopify_company_id ?? '',
      customerHash,
      ipHash,
    );
  } catch (err) {
    log('warn', 'asset download log failed', {
      shop_id: buyer.shop_id,
      asset_id: asset.id,
      error: String(err),
    });
  }
  if (bytes > 0) {
    await recordDownload(env.KV_HOT_CACHE, buyer.shop_id, bytes);
  }
}
