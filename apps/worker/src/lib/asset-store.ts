/**
 * Asset CRUD + visibility-rule write-side.
 *
 * Assets carry a `visibility_mode`:
 *   - `all_b2b`   — every approved B2B buyer can see it
 *   - `tiers`     — restricted to the tier_ids listed in asset_visibility_rules
 *   - `companies` — restricted to the Company GIDs listed in asset_visibility_rules
 *
 * The reader-side (asset-visibility.ts) resolves what a given customer can see;
 * this module is purely the merchant-facing write surface plus a fetch helper
 * that returns the visibility-rule rows joined in.
 */

import type { AssetType } from './r2-keys.js';

export type AssetVisibilityMode = 'all_b2b' | 'tiers' | 'companies';

export class AssetValidationError extends Error {}

const ASSET_TYPES: ReadonlyArray<AssetType> = ['image', 'pdf', 'video', 'link'];
const VISIBILITY_MODES: ReadonlyArray<AssetVisibilityMode> = [
  'all_b2b',
  'tiers',
  'companies',
];

export interface AssetInput {
  folder_id: number | null;
  type: AssetType;
  title: string;
  description: string | null;
  r2_key: string | null;
  external_url: string | null;
  file_size_bytes: number | null;
  mime_type: string | null;
  visibility_mode: AssetVisibilityMode;
  uploaded_by: string;
}

export interface AssetVisibilityRule {
  rule_type: 'tier' | 'company';
  rule_target_id: string;
}

export interface Asset {
  id: number;
  shop_id: number;
  folder_id: number | null;
  type: AssetType;
  title: string;
  description: string | null;
  r2_key: string | null;
  external_url: string | null;
  file_size_bytes: number | null;
  mime_type: string | null;
  visibility_mode: AssetVisibilityMode;
  uploaded_at: number;
  uploaded_by: string;
  deleted_at: number | null;
}

export function validateAssetInput(input: unknown): AssetInput {
  if (typeof input !== 'object' || input === null) {
    throw new AssetValidationError('asset payload must be an object');
  }
  const a = input as Record<string, unknown>;

  if (typeof a.title !== 'string' || a.title.trim().length === 0 || a.title.length > 200) {
    throw new AssetValidationError('title must be 1-200 chars');
  }
  if (
    typeof a.type !== 'string' ||
    !(ASSET_TYPES as readonly string[]).includes(a.type)
  ) {
    throw new AssetValidationError(`type must be one of ${ASSET_TYPES.join(', ')}`);
  }
  if (
    typeof a.visibility_mode !== 'string' ||
    !(VISIBILITY_MODES as readonly string[]).includes(a.visibility_mode)
  ) {
    throw new AssetValidationError(
      `visibility_mode must be one of ${VISIBILITY_MODES.join(', ')}`,
    );
  }
  if (typeof a.uploaded_by !== 'string' || a.uploaded_by.length === 0) {
    throw new AssetValidationError('uploaded_by is required');
  }

  // Storage invariant: a `link` asset has an external_url and no r2_key; every
  // other type has an r2_key and (typically) no external_url.
  if (a.type === 'link') {
    if (typeof a.external_url !== 'string' || a.external_url.length === 0) {
      throw new AssetValidationError('link assets require external_url');
    }
    if (a.r2_key) {
      throw new AssetValidationError('link assets must not carry an r2_key');
    }
    try {
      const u = new URL(a.external_url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new Error('not http(s)');
      }
    } catch {
      throw new AssetValidationError('external_url must be a valid http(s) URL');
    }
  } else {
    if (typeof a.r2_key !== 'string' || a.r2_key.length === 0) {
      throw new AssetValidationError(`${a.type} assets require r2_key`);
    }
    if (a.external_url) {
      throw new AssetValidationError('non-link assets must not carry an external_url');
    }
  }

  const folderId = a.folder_id;
  if (folderId !== null && folderId !== undefined) {
    if (!Number.isInteger(folderId) || (folderId as number) <= 0) {
      throw new AssetValidationError('folder_id must be a positive integer or null');
    }
  }

  const size = a.file_size_bytes;
  if (size !== null && size !== undefined) {
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      throw new AssetValidationError('file_size_bytes must be a non-negative number or null');
    }
  }

  return {
    folder_id: (folderId as number | null | undefined) ?? null,
    type: a.type as AssetType,
    title: (a.title as string).trim(),
    description:
      typeof a.description === 'string' && a.description.length > 0
        ? a.description
        : null,
    r2_key: (a.r2_key as string | null | undefined) ?? null,
    external_url: (a.external_url as string | null | undefined) ?? null,
    file_size_bytes: (size as number | null | undefined) ?? null,
    mime_type:
      typeof a.mime_type === 'string' && a.mime_type.length > 0 ? a.mime_type : null,
    visibility_mode: a.visibility_mode as AssetVisibilityMode,
    uploaded_by: a.uploaded_by as string,
  };
}

function rowToAsset(row: Record<string, unknown>): Asset {
  return {
    id: row.id as number,
    shop_id: row.shop_id as number,
    folder_id: (row.folder_id as number | null) ?? null,
    type: row.type as AssetType,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    r2_key: (row.r2_key as string | null) ?? null,
    external_url: (row.external_url as string | null) ?? null,
    file_size_bytes: (row.file_size_bytes as number | null) ?? null,
    mime_type: (row.mime_type as string | null) ?? null,
    visibility_mode: row.visibility_mode as AssetVisibilityMode,
    uploaded_at: row.uploaded_at as number,
    uploaded_by: row.uploaded_by as string,
    deleted_at: (row.deleted_at as number | null) ?? null,
  };
}

export async function listAssets(db: D1Database, shopId: number): Promise<Asset[]> {
  const result = await db
    .prepare(
      `SELECT id, shop_id, folder_id, type, title, description, r2_key, external_url,
              file_size_bytes, mime_type, visibility_mode, uploaded_at, uploaded_by, deleted_at
       FROM assets
       WHERE shop_id = ? AND deleted_at IS NULL
       ORDER BY uploaded_at DESC`,
    )
    .bind(shopId)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(rowToAsset);
}

export async function getAsset(
  db: D1Database,
  shopId: number,
  assetId: number,
): Promise<Asset | null> {
  const row = await db
    .prepare(
      `SELECT id, shop_id, folder_id, type, title, description, r2_key, external_url,
              file_size_bytes, mime_type, visibility_mode, uploaded_at, uploaded_by, deleted_at
       FROM assets
       WHERE shop_id = ? AND id = ?`,
    )
    .bind(shopId, assetId)
    .first<Record<string, unknown>>();
  return row ? rowToAsset(row) : null;
}

export async function createAsset(
  db: D1Database,
  shopId: number,
  input: AssetInput,
  rules: AssetVisibilityRule[],
): Promise<Asset> {
  validateRulesAgainstMode(input.visibility_mode, rules);

  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      `INSERT INTO assets
         (shop_id, folder_id, type, title, description, r2_key, external_url,
          file_size_bytes, mime_type, visibility_mode, uploaded_at, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      shopId,
      input.folder_id,
      input.type,
      input.title,
      input.description,
      input.r2_key,
      input.external_url,
      input.file_size_bytes,
      input.mime_type,
      input.visibility_mode,
      now,
      input.uploaded_by,
    )
    .first<{ id: number }>();

  if (!result) throw new Error('createAsset: no row returned');

  if (rules.length > 0) {
    await replaceVisibilityRules(db, result.id, rules);
  }

  return {
    id: result.id,
    shop_id: shopId,
    ...input,
    uploaded_at: now,
    deleted_at: null,
  };
}

export async function updateAssetMetadata(
  db: D1Database,
  shopId: number,
  assetId: number,
  patch: { title?: string; description?: string | null; folder_id?: number | null },
): Promise<Asset | null> {
  const existing = await getAsset(db, shopId, assetId);
  if (!existing || existing.deleted_at !== null) return null;

  const title =
    patch.title !== undefined
      ? assertValidTitle(patch.title)
      : existing.title;
  const description =
    patch.description !== undefined ? patch.description : existing.description;
  const folderId =
    patch.folder_id !== undefined ? patch.folder_id : existing.folder_id;

  if (folderId !== null && (!Number.isInteger(folderId) || folderId <= 0)) {
    throw new AssetValidationError('folder_id must be a positive integer or null');
  }

  const res = await db
    .prepare(
      `UPDATE assets
         SET title = ?, description = ?, folder_id = ?
       WHERE shop_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .bind(title, description, folderId, shopId, assetId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return null;
  return getAsset(db, shopId, assetId);
}

function assertValidTitle(title: string): string {
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 200) {
    throw new AssetValidationError('title must be 1-200 chars');
  }
  return title.trim();
}

export async function setAssetVisibility(
  db: D1Database,
  shopId: number,
  assetId: number,
  mode: AssetVisibilityMode,
  rules: AssetVisibilityRule[],
): Promise<Asset | null> {
  validateRulesAgainstMode(mode, rules);
  const existing = await getAsset(db, shopId, assetId);
  if (!existing || existing.deleted_at !== null) return null;

  await db
    .prepare(
      `UPDATE assets SET visibility_mode = ?
       WHERE shop_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .bind(mode, shopId, assetId)
    .run();
  await replaceVisibilityRules(db, assetId, rules);
  return getAsset(db, shopId, assetId);
}

export async function softDeleteAsset(
  db: D1Database,
  shopId: number,
  assetId: number,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare(
      `UPDATE assets SET deleted_at = ?
       WHERE shop_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .bind(now, shopId, assetId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function listVisibilityRules(
  db: D1Database,
  assetId: number,
): Promise<AssetVisibilityRule[]> {
  const result = await db
    .prepare(
      `SELECT rule_type, rule_target_id
       FROM asset_visibility_rules
       WHERE asset_id = ?`,
    )
    .bind(assetId)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(r => ({
    rule_type: r.rule_type as 'tier' | 'company',
    rule_target_id: r.rule_target_id as string,
  }));
}

async function replaceVisibilityRules(
  db: D1Database,
  assetId: number,
  rules: AssetVisibilityRule[],
): Promise<void> {
  await db
    .prepare(`DELETE FROM asset_visibility_rules WHERE asset_id = ?`)
    .bind(assetId)
    .run();
  for (const rule of rules) {
    await db
      .prepare(
        `INSERT INTO asset_visibility_rules (asset_id, rule_type, rule_target_id)
         VALUES (?, ?, ?)`,
      )
      .bind(assetId, rule.rule_type, rule.rule_target_id)
      .run();
  }
}

export function validateRulesAgainstMode(
  mode: AssetVisibilityMode,
  rules: AssetVisibilityRule[],
): void {
  if (mode === 'all_b2b') {
    if (rules.length > 0) {
      throw new AssetValidationError('all_b2b visibility cannot have rules');
    }
    return;
  }
  if (rules.length === 0) {
    throw new AssetValidationError(`${mode} visibility requires at least one rule`);
  }
  const expectedType = mode === 'tiers' ? 'tier' : 'company';
  for (const rule of rules) {
    if (rule.rule_type !== expectedType) {
      throw new AssetValidationError(
        `${mode} visibility rules must all be of rule_type=${expectedType}`,
      );
    }
    if (typeof rule.rule_target_id !== 'string' || rule.rule_target_id.length === 0) {
      throw new AssetValidationError('rule_target_id is required');
    }
  }
}

/**
 * Bulk operations: move N assets to a folder, set visibility, or soft-delete.
 * Bulk visibility uses `all_b2b` only — per-target rules need per-asset edits
 * because the rule rows differ. Bulk-tag is a v2 polish (no tags column yet).
 */
export async function bulkMoveAssets(
  db: D1Database,
  shopId: number,
  assetIds: number[],
  folderId: number | null,
): Promise<number> {
  if (assetIds.length === 0) return 0;
  if (folderId !== null && (!Number.isInteger(folderId) || folderId <= 0)) {
    throw new AssetValidationError('folder_id must be a positive integer or null');
  }
  const placeholders = assetIds.map(() => '?').join(',');
  const res = await db
    .prepare(
      `UPDATE assets SET folder_id = ?
       WHERE shop_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    )
    .bind(folderId, shopId, ...assetIds)
    .run();
  return res.meta?.changes ?? 0;
}

export async function bulkSetVisibility(
  db: D1Database,
  shopId: number,
  assetIds: number[],
  mode: 'all_b2b',
): Promise<number> {
  if (assetIds.length === 0) return 0;
  if (mode !== 'all_b2b') {
    // Tier/company visibility needs per-asset rule rows.
    throw new AssetValidationError('bulk visibility only supports all_b2b');
  }
  const placeholders = assetIds.map(() => '?').join(',');
  const res = await db
    .prepare(
      `UPDATE assets SET visibility_mode = ?
       WHERE shop_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    )
    .bind(mode, shopId, ...assetIds)
    .run();
  if ((res.meta?.changes ?? 0) > 0) {
    await db
      .prepare(
        `DELETE FROM asset_visibility_rules
         WHERE asset_id IN (${placeholders})`,
      )
      .bind(...assetIds)
      .run();
  }
  return res.meta?.changes ?? 0;
}

export async function bulkSoftDelete(
  db: D1Database,
  shopId: number,
  assetIds: number[],
): Promise<number> {
  if (assetIds.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  const placeholders = assetIds.map(() => '?').join(',');
  const res = await db
    .prepare(
      `UPDATE assets SET deleted_at = ?
       WHERE shop_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    )
    .bind(now, shopId, ...assetIds)
    .run();
  return res.meta?.changes ?? 0;
}

export async function logAssetDownload(
  db: D1Database,
  shopId: number,
  assetId: number,
  shopifyCompanyId: string,
  customerIdHash: string,
  ipHash: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO asset_downloads
         (shop_id, asset_id, shopify_company_id, shopify_customer_id, downloaded_at, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(shopId, assetId, shopifyCompanyId, customerIdHash, now, ipHash)
    .run();
}
