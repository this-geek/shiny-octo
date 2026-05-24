/**
 * R2 key conventions for the dealer asset portal (DECISIONS #3).
 *
 *   shops/<shop_id>/assets/<asset_id>/<variant>
 *
 * Variants:
 *   - `original`     — the merchant-uploaded file (always present for non-link assets)
 *   - `web`          — 1200px wide JPG (images only; Cloudflare Images output)
 *   - `thumb`        — 300px square JPG (images only)
 *
 * Multipart upload sessions land at a different prefix so we can scan them for
 * cleanup of orphaned parts without touching live asset data:
 *
 *   shops/<shop_id>/uploads/<upload_id>/<filename>
 */

export type AssetVariant = 'original' | 'web' | 'thumb';

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const ALLOWED_PDF_MIME = new Set(['application/pdf']);

const ALLOWED_VIDEO_MIME = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

const MAX_VIDEO_SIZE_BYTES = 500 * 1024 * 1024; // §4.4

export type AssetType = 'image' | 'pdf' | 'video' | 'link';

export function inferAssetType(mime: string | null | undefined): AssetType | null {
  if (!mime) return null;
  if (ALLOWED_IMAGE_MIME.has(mime)) return 'image';
  if (ALLOWED_PDF_MIME.has(mime)) return 'pdf';
  if (ALLOWED_VIDEO_MIME.has(mime)) return 'video';
  return null;
}

export function isMimeAllowed(mime: string): boolean {
  return inferAssetType(mime) !== null;
}

export function isSizeWithinLimit(type: AssetType, sizeBytes: number): boolean {
  if (type === 'video') return sizeBytes <= MAX_VIDEO_SIZE_BYTES;
  return sizeBytes >= 0;
}

export function assetKey(shopId: number, assetId: number, variant: AssetVariant): string {
  return `shops/${shopId}/assets/${assetId}/${variant}`;
}

export function uploadSessionPrefix(shopId: number, uploadId: string): string {
  return `shops/${shopId}/uploads/${uploadId}`;
}

/**
 * The keys we control end with the asset_id-derived suffix; anything that
 * doesn't match the expected shape is rejected before R2 talks to it. This
 * prevents a (very unlikely) row in `assets.r2_key` with a bogus value from
 * exfiltrating data from a different shop.
 */
export function assertKeyBelongsToShop(key: string, shopId: number): void {
  const expectedPrefix = `shops/${shopId}/`;
  if (!key.startsWith(expectedPrefix)) {
    throw new Error(`r2 key ${key} does not belong to shop ${shopId}`);
  }
}
