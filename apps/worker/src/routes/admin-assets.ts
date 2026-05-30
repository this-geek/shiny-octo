import { Hono } from 'hono';
import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import {
  FolderValidationError,
  createFolder,
  listFolders,
  renameFolder,
  softDeleteFolder,
  validateFolderInput,
} from '../lib/folder-store.js';
import {
  AssetValidationError,
  bulkMoveAssets,
  bulkSetVisibility,
  bulkSoftDelete,
  createAsset,
  getAsset,
  listAssets,
  listVisibilityRules,
  setAssetVisibility,
  softDeleteAsset,
  updateAssetMetadata,
  validateAssetInput,
  type AssetVisibilityMode,
  type AssetVisibilityRule,
} from '../lib/asset-store.js';
import {
  assetKey,
  inferAssetType,
  isMimeAllowed,
  isSizeWithinLimit,
  uploadSessionPrefix,
} from '../lib/r2-keys.js';
import {
  deleteSession,
  loadSession,
  newSessionId,
  saveSession,
  type UploadedPart,
} from '../lib/r2-multipart.js';
import { writeAudit } from '../lib/audit-log.js';

// Mounted under adminRouter, which applies sessionTokenMiddleware globally.
export const adminAssetsRouter = new Hono<{ Bindings: Env }>();

async function resolveShopId(env: Env, shopDomain: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ id: number }>();
  return row?.id ?? null;
}

function parseRules(raw: unknown): AssetVisibilityRule[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new AssetValidationError('rules must be an array');
  return raw.map(r => {
    if (typeof r !== 'object' || r === null) {
      throw new AssetValidationError('rule must be an object');
    }
    const rr = r as Record<string, unknown>;
    if (rr.rule_type !== 'tier' && rr.rule_type !== 'company') {
      throw new AssetValidationError('rule.rule_type must be tier or company');
    }
    if (typeof rr.rule_target_id !== 'string' || rr.rule_target_id.length === 0) {
      throw new AssetValidationError('rule.rule_target_id is required');
    }
    return {
      rule_type: rr.rule_type,
      rule_target_id: rr.rule_target_id,
    };
  });
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

adminAssetsRouter.get('/asset-folders', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);
  const folders = await listFolders(c.env.DB, shopId);
  return c.json({ folders });
});

adminAssetsRouter.post('/asset-folders', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  let input;
  try {
    input = validateFolderInput(body);
  } catch (err) {
    const message = err instanceof FolderValidationError ? err.message : 'invalid payload';
    return c.json({ error: message }, 400);
  }

  try {
    const folder = await createFolder(c.env.DB, shopId, input);
    log('info', 'admin: folder created', { shop: shopDomain, folder_id: folder.id });
    return c.json({ folder }, 201);
  } catch (err) {
    if (err instanceof FolderValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

adminAssetsRouter.put('/asset-folders/:id', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const b = (body ?? {}) as { name?: unknown; visibility_mode?: unknown };
  try {
    const folder = await renameFolder(
      c.env.DB,
      shopId,
      id,
      b.name as string,
      b.visibility_mode as 'all_b2b' | 'tiers' | 'companies',
    );
    if (!folder) return c.json({ error: 'folder not found' }, 404);
    return c.json({ folder });
  } catch (err) {
    if (err instanceof FolderValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

adminAssetsRouter.delete('/asset-folders/:id', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  const removed = await softDeleteFolder(c.env.DB, shopId, id);
  if (!removed) return c.json({ error: 'folder not found' }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Assets — list, create, update metadata, visibility, delete
// ---------------------------------------------------------------------------

adminAssetsRouter.get('/assets', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);
  const assets = await listAssets(c.env.DB, shopId);
  return c.json({ assets });
});

adminAssetsRouter.get('/assets/:id', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  const asset = await getAsset(c.env.DB, shopId, id);
  if (!asset || asset.deleted_at !== null) return c.json({ error: 'asset not found' }, 404);

  const rules = await listVisibilityRules(c.env.DB, asset.id);
  return c.json({ asset, rules });
});

adminAssetsRouter.post('/assets', async c => {
  // Used for `link` assets and for assets whose R2 upload completed via the
  // multipart finalisation route (the client passes the resulting r2_key here).
  const shopDomain = c.get('shopDomain');
  const sessionPayload = c.get('sessionPayload');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  let input;
  let rules: AssetVisibilityRule[];
  try {
    const b = (body ?? {}) as Record<string, unknown>;
    rules = parseRules(b.rules);
    input = validateAssetInput({ ...b, uploaded_by: sessionPayload.sub });
  } catch (err) {
    const message = err instanceof AssetValidationError ? err.message : 'invalid payload';
    return c.json({ error: message }, 400);
  }

  // If we got an r2_key, it must belong to this shop.
  if (input.r2_key && !input.r2_key.startsWith(`shops/${shopId}/`)) {
    return c.json({ error: 'r2_key does not belong to this shop' }, 400);
  }
  if (input.type !== 'link' && input.mime_type && !isMimeAllowed(input.mime_type)) {
    return c.json({ error: `mime_type ${input.mime_type} is not allowed` }, 400);
  }
  if (
    input.type === 'video' &&
    input.file_size_bytes !== null &&
    !isSizeWithinLimit('video', input.file_size_bytes)
  ) {
    return c.json({ error: 'video exceeds 500MB limit' }, 400);
  }

  try {
    const asset = await createAsset(c.env.DB, shopId, input, rules);
    await writeAudit(c.env.DB, {
      shopId,
      actor: sessionPayload.sub,
      action: 'asset.create',
      entityType: 'asset',
      entityId: asset.id,
      details: {
        type: asset.type,
        visibility_mode: asset.visibility_mode,
        rule_count: rules.length,
      },
    });
    log('info', 'admin: asset created', {
      shop: shopDomain,
      asset_id: asset.id,
      type: asset.type,
    });
    return c.json({ asset }, 201);
  } catch (err) {
    if (err instanceof AssetValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

adminAssetsRouter.put('/assets/:id', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const patch: { title?: string; description?: string | null; folder_id?: number | null } = {};
  if (typeof b.title === 'string') patch.title = b.title;
  if (b.description === null || typeof b.description === 'string') {
    patch.description = b.description as string | null;
  }
  if (b.folder_id === null || Number.isInteger(b.folder_id)) {
    patch.folder_id = b.folder_id as number | null;
  }

  try {
    const asset = await updateAssetMetadata(c.env.DB, shopId, id, patch);
    if (!asset) return c.json({ error: 'asset not found' }, 404);
    return c.json({ asset });
  } catch (err) {
    if (err instanceof AssetValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

adminAssetsRouter.put('/assets/:id/visibility', async c => {
  const shopDomain = c.get('shopDomain');
  const sessionPayload = c.get('sessionPayload');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const b = (body ?? {}) as { visibility_mode?: unknown; rules?: unknown };
  const mode = b.visibility_mode as AssetVisibilityMode;
  let rules: AssetVisibilityRule[];
  try {
    rules = parseRules(b.rules);
  } catch (err) {
    const message = err instanceof AssetValidationError ? err.message : 'invalid rules';
    return c.json({ error: message }, 400);
  }

  const before = await getAsset(c.env.DB, shopId, id);
  const beforeRules = before ? await listVisibilityRules(c.env.DB, before.id) : [];

  try {
    const asset = await setAssetVisibility(c.env.DB, shopId, id, mode, rules);
    if (!asset) return c.json({ error: 'asset not found' }, 404);
    await writeAudit(c.env.DB, {
      shopId,
      actor: sessionPayload.sub,
      action: 'asset.visibility.update',
      entityType: 'asset',
      entityId: id,
      details: {
        before: {
          visibility_mode: before?.visibility_mode ?? null,
          rules: beforeRules,
        },
        after: { visibility_mode: mode, rules },
      },
    });
    return c.json({ asset, rules });
  } catch (err) {
    if (err instanceof AssetValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

adminAssetsRouter.delete('/assets/:id', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  const removed = await softDeleteAsset(c.env.DB, shopId, id);
  if (!removed) return c.json({ error: 'asset not found' }, 404);

  const sessionPayload = c.get('sessionPayload');
  await writeAudit(c.env.DB, {
    shopId,
    actor: sessionPayload.sub,
    action: 'asset.delete',
    entityType: 'asset',
    entityId: id,
  });

  // Note: the R2 object is left in place for v1 (recovery window). A nightly
  // cron should hard-delete R2 objects whose D1 rows have been soft-deleted
  // for >30 days; that lands with §4.4 acceptance test backlog.
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

interface BulkBody {
  asset_ids?: unknown;
  folder_id?: unknown;
  visibility_mode?: unknown;
}

function parseAssetIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw new AssetValidationError('asset_ids must be an array');
  const ids = raw.map(v => {
    if (!Number.isInteger(v) || (v as number) <= 0) {
      throw new AssetValidationError('asset_ids must be positive integers');
    }
    return v as number;
  });
  if (ids.length === 0) throw new AssetValidationError('asset_ids must not be empty');
  if (ids.length > 500) throw new AssetValidationError('asset_ids capped at 500 per request');
  return ids;
}

adminAssetsRouter.post('/assets/bulk-move', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  let body: BulkBody;
  try {
    body = (await c.req.json()) as BulkBody;
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  try {
    const ids = parseAssetIds(body.asset_ids);
    const folderId = body.folder_id;
    if (folderId !== null && !Number.isInteger(folderId)) {
      return c.json({ error: 'folder_id must be an integer or null' }, 400);
    }
    const changed = await bulkMoveAssets(
      c.env.DB,
      shopId,
      ids,
      folderId as number | null,
    );
    return c.json({ moved: changed });
  } catch (err) {
    if (err instanceof AssetValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

adminAssetsRouter.post('/assets/bulk-visibility', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  let body: BulkBody;
  try {
    body = (await c.req.json()) as BulkBody;
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  try {
    const ids = parseAssetIds(body.asset_ids);
    if (body.visibility_mode !== 'all_b2b') {
      return c.json({ error: 'bulk visibility only supports all_b2b' }, 400);
    }
    const changed = await bulkSetVisibility(c.env.DB, shopId, ids, 'all_b2b');
    if (changed > 0) {
      const sessionPayload = c.get('sessionPayload');
      await writeAudit(c.env.DB, {
        shopId,
        actor: sessionPayload.sub,
        action: 'asset.visibility.bulk_update',
        entityType: 'asset',
        entityId: ids.join(','),
        details: { asset_ids: ids, visibility_mode: 'all_b2b', changed },
      });
    }
    return c.json({ updated: changed });
  } catch (err) {
    if (err instanceof AssetValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

adminAssetsRouter.post('/assets/bulk-delete', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  let body: BulkBody;
  try {
    body = (await c.req.json()) as BulkBody;
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  try {
    const ids = parseAssetIds(body.asset_ids);
    const removed = await bulkSoftDelete(c.env.DB, shopId, ids);
    if (removed > 0) {
      const sessionPayload = c.get('sessionPayload');
      await writeAudit(c.env.DB, {
        shopId,
        actor: sessionPayload.sub,
        action: 'asset.bulk_delete',
        entityType: 'asset',
        entityId: ids.join(','),
        details: { asset_ids: ids, deleted: removed },
      });
    }
    return c.json({ deleted: removed });
  } catch (err) {
    if (err instanceof AssetValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Multipart upload session
// ---------------------------------------------------------------------------

adminAssetsRouter.post('/assets/uploads', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const b = (body ?? {}) as {
    filename?: unknown;
    mime_type?: unknown;
    total_size_bytes?: unknown;
  };
  if (typeof b.filename !== 'string' || b.filename.length === 0 || b.filename.length > 255) {
    return c.json({ error: 'filename must be 1-255 chars' }, 400);
  }
  if (typeof b.mime_type !== 'string' || !isMimeAllowed(b.mime_type)) {
    return c.json({ error: 'mime_type missing or not allowed' }, 400);
  }
  if (
    typeof b.total_size_bytes !== 'number' ||
    !Number.isFinite(b.total_size_bytes) ||
    b.total_size_bytes <= 0
  ) {
    return c.json({ error: 'total_size_bytes must be a positive number' }, 400);
  }
  const assetType = inferAssetType(b.mime_type);
  if (assetType && !isSizeWithinLimit(assetType, b.total_size_bytes)) {
    return c.json({ error: `${assetType} exceeds size limit` }, 400);
  }

  const sessionId = newSessionId();
  // Use the random session id as the R2 key suffix so we never collide with a
  // live asset key (which uses the numeric asset_id). The final r2_key is
  // returned to the client on /complete so they can attach it to the asset row.
  const key = `${uploadSessionPrefix(shopId, sessionId)}/${sanitiseFilename(b.filename)}`;
  let multipart;
  try {
    multipart = await c.env.ASSETS_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: b.mime_type },
    });
  } catch (err) {
    log('error', 'admin: r2 createMultipartUpload failed', {
      shop: shopDomain,
      error: String(err),
    });
    return c.json({ error: 'failed to start upload' }, 502);
  }

  await saveSession(c.env.KV_IDEMPOTENCY, sessionId, {
    shop_id: shopId,
    key,
    upload_id: multipart.uploadId,
    filename: b.filename,
    mime_type: b.mime_type,
    total_size_bytes: b.total_size_bytes,
    created_at: Math.floor(Date.now() / 1000),
  });

  log('info', 'admin: upload session started', {
    shop: shopDomain,
    session: sessionId,
    bytes: b.total_size_bytes,
  });

  return c.json({
    session_id: sessionId,
    key,
    recommended_part_size: 64 * 1024 * 1024, // 64 MiB, well under Workers' 100MB cap
  });
});

adminAssetsRouter.put('/assets/uploads/:sessionId/parts/:partNumber', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const sessionId = c.req.param('sessionId');
  const partNumber = Number.parseInt(c.req.param('partNumber'), 10);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return c.json({ error: 'partNumber must be 1-10000' }, 400);
  }

  const session = await loadSession(c.env.KV_IDEMPOTENCY, shopId, sessionId);
  if (!session) return c.json({ error: 'session not found or expired' }, 404);

  const body = c.req.raw.body;
  if (!body) return c.json({ error: 'request body required' }, 400);

  try {
    const multipart = c.env.ASSETS_BUCKET.resumeMultipartUpload(
      session.key,
      session.upload_id,
    );
    const part = await multipart.uploadPart(partNumber, body);
    return c.json({ partNumber: part.partNumber, etag: part.etag });
  } catch (err) {
    log('error', 'admin: r2 uploadPart failed', {
      shop: shopDomain,
      session: sessionId,
      part: partNumber,
      error: String(err),
    });
    return c.json({ error: 'failed to upload part' }, 502);
  }
});

adminAssetsRouter.post('/assets/uploads/:sessionId/complete', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const sessionId = c.req.param('sessionId');
  const session = await loadSession(c.env.KV_IDEMPOTENCY, shopId, sessionId);
  if (!session) return c.json({ error: 'session not found or expired' }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const parts = (body as { parts?: unknown }).parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    return c.json({ error: 'parts must be a non-empty array' }, 400);
  }
  const uploaded: UploadedPart[] = parts.map(p => {
    const pp = p as Record<string, unknown>;
    return {
      partNumber: pp.partNumber as number,
      etag: pp.etag as string,
    };
  });

  try {
    const multipart = c.env.ASSETS_BUCKET.resumeMultipartUpload(
      session.key,
      session.upload_id,
    );
    await multipart.complete(uploaded);
  } catch (err) {
    log('error', 'admin: r2 multipart.complete failed', {
      shop: shopDomain,
      session: sessionId,
      error: String(err),
    });
    return c.json({ error: 'failed to finalise upload' }, 502);
  }

  await deleteSession(c.env.KV_IDEMPOTENCY, shopId, sessionId);
  log('info', 'admin: upload session completed', {
    shop: shopDomain,
    session: sessionId,
    key: session.key,
  });

  return c.json({
    key: session.key,
    mime_type: session.mime_type,
    total_size_bytes: session.total_size_bytes,
  });
});

adminAssetsRouter.post('/assets/uploads/:sessionId/abort', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const sessionId = c.req.param('sessionId');
  const session = await loadSession(c.env.KV_IDEMPOTENCY, shopId, sessionId);
  if (!session) return c.json({ error: 'session not found' }, 404);

  try {
    const multipart = c.env.ASSETS_BUCKET.resumeMultipartUpload(
      session.key,
      session.upload_id,
    );
    await multipart.abort();
  } catch (err) {
    log('warn', 'admin: r2 multipart.abort failed', {
      shop: shopDomain,
      session: sessionId,
      error: String(err),
    });
  }

  await deleteSession(c.env.KV_IDEMPOTENCY, shopId, sessionId);
  return c.json({ ok: true });
});

/**
 * After /complete returns, the admin calls POST /assets to persist a row and
 * gets back the asset_id. We then move the upload object from the
 * `shops/<shop_id>/uploads/<session>/<filename>` key into the canonical
 * `shops/<shop_id>/assets/<asset_id>/original` location with a server-side
 * copy. Done as a separate endpoint so the asset row exists before its R2
 * data appears under the canonical path (transactionally cleanest given
 * R2's no-rename semantics).
 */
adminAssetsRouter.post('/assets/:id/finalise-upload', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  const asset = await getAsset(c.env.DB, shopId, id);
  if (!asset || asset.deleted_at !== null) return c.json({ error: 'asset not found' }, 404);
  if (!asset.r2_key) return c.json({ error: 'asset has no r2_key to finalise' }, 400);
  if (!asset.r2_key.startsWith(`shops/${shopId}/`)) {
    return c.json({ error: 'r2_key does not belong to this shop' }, 400);
  }

  const canonical = assetKey(shopId, id, 'original');
  if (asset.r2_key === canonical) return c.json({ ok: true, key: canonical });

  // Stream-copy from temp upload key to canonical asset key, then delete the
  // temp object. R2 has no native rename; this is the standard pattern.
  const src = await c.env.ASSETS_BUCKET.get(asset.r2_key);
  if (!src) return c.json({ error: 'source object not found' }, 404);

  await c.env.ASSETS_BUCKET.put(canonical, src.body, {
    httpMetadata: src.httpMetadata,
  });
  await c.env.ASSETS_BUCKET.delete(asset.r2_key);

  await c.env.DB.prepare(
    `UPDATE assets SET r2_key = ? WHERE shop_id = ? AND id = ?`,
  )
    .bind(canonical, shopId, id)
    .run();

  return c.json({ ok: true, key: canonical });
});

function sanitiseFilename(name: string): string {
  // R2 accepts most characters in keys but we don't want to invite ambiguity:
  // collapse any run of characters outside [A-Za-z0-9._-] to a single
  // underscore, then cap length.
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'upload';
}
