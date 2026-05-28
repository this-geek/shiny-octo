/**
 * GDPR data export + redact primitives.
 *
 * `exportCustomerData` gathers everything we hold about one buyer for the
 * `customers/data_request` flow. The bundle is shipped to the shop owner
 * by email; they are responsible for forwarding to the buyer within 30
 * days (Shopify's model — we never have the buyer's contact channel).
 *
 * `redactCustomer` deletes that buyer's PII from D1 + R2 + KV.
 *
 * `redactShop` is the nuclear option used for both `shop/redact` and the
 * deferred uninstall purge. It deletes every row scoped by `shop_id`
 * across every PII-bearing table, then the `shops` row last.
 *
 * Every read and every write is fenced by `shop_id`; the only path that
 * can cross-tenant is a bug in this file, so the test suite explicitly
 * seeds two shops and asserts the bystander is untouched.
 */

import type { Env } from '../types.js';
import { hashIdAsync } from './logger.js';
import { assertKeyBelongsToShop } from './r2-keys.js';
import { decryptForm } from './application-store.js';

export interface ExportedApplication {
  id: number;
  email: string;
  status: string;
  submitted_at: number | null;
  decided_at: number | null;
  decision_notes: string | null;
  created_company_id: string | null;
  created_location_id: string | null;
  shopify_customer_id: string | null;
  form: unknown;
}

export interface ExportedAssetDownload {
  asset_id: number;
  shopify_company_id: string;
  downloaded_at: number;
}

export interface ExportedDocument {
  r2_key: string;
  size_bytes: number | null;
}

export interface CustomerExportBundle {
  shop_id: number;
  shop_domain: string;
  shopify_customer_id: string;
  exported_at: number;
  applications: ExportedApplication[];
  asset_downloads: ExportedAssetDownload[];
  documents: ExportedDocument[];
}

/**
 * Read every row tied to this customer. Pure read — no DB writes, no R2
 * deletes. The `documents` array carries R2 keys so the email handler
 * can attach signed links or stream the content into the message.
 */
export async function exportCustomerData(
  env: Env,
  shopId: number,
  shopDomain: string,
  customerId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<CustomerExportBundle> {
  const apps = await env.DB.prepare(
    `SELECT id, email, status, submitted_at, decided_at, decision_notes,
            created_company_id, created_location_id, shopify_customer_id,
            form_data_encrypted
     FROM applications
     WHERE shop_id = ? AND shopify_customer_id = ?`,
  )
    .bind(shopId, customerId)
    .all<Record<string, unknown>>();

  const applications: ExportedApplication[] = [];
  const documents: ExportedDocument[] = [];

  for (const row of apps.results ?? []) {
    let form: unknown = null;
    try {
      const decrypted = await decryptForm(
        row.form_data_encrypted as string,
        shopDomain,
        env.MASTER_KEY,
      );
      form = decrypted;
      for (const doc of decrypted.documents ?? []) {
        documents.push({ r2_key: doc.r2_key, size_bytes: doc.size ?? null });
      }
    } catch {
      // Unreadable blob is still data we held about the buyer; report the
      // bare metadata so the merchant knows it existed.
      form = { error: 'form payload unreadable' };
    }
    applications.push({
      id: row.id as number,
      email: row.email as string,
      status: row.status as string,
      submitted_at: (row.submitted_at as number | null) ?? null,
      decided_at: (row.decided_at as number | null) ?? null,
      decision_notes: (row.decision_notes as string | null) ?? null,
      created_company_id: (row.created_company_id as string | null) ?? null,
      created_location_id: (row.created_location_id as string | null) ?? null,
      shopify_customer_id: (row.shopify_customer_id as string | null) ?? null,
      form,
    });
  }

  const customerHash = await hashIdAsync(customerId);
  const downloads = await env.DB.prepare(
    `SELECT asset_id, shopify_company_id, downloaded_at
     FROM asset_downloads
     WHERE shop_id = ? AND shopify_customer_id = ?`,
  )
    .bind(shopId, customerHash)
    .all<Record<string, unknown>>();

  const asset_downloads: ExportedAssetDownload[] = (downloads.results ?? []).map(r => ({
    asset_id: r.asset_id as number,
    shopify_company_id: r.shopify_company_id as string,
    downloaded_at: r.downloaded_at as number,
  }));

  return {
    shop_id: shopId,
    shop_domain: shopDomain,
    shopify_customer_id: customerId,
    exported_at: now,
    applications,
    asset_downloads,
    documents,
  };
}

export interface CustomerRedactResult {
  applications_deleted: number;
  asset_downloads_deleted: number;
  r2_objects_deleted: number;
  kv_keys_deleted: number;
}

/**
 * Hard-delete every trace of a buyer from this shop:
 *   - `applications` rows by shopify_customer_id (+ child `application_nudges`)
 *   - `asset_downloads` rows by sha256(customer_id)
 *   - R2 objects under shops/<shop_id>/applications/<application_id>/
 *   - KV cache key `tier:<shop_id>:<customer_hash>`
 */
export async function redactCustomer(
  env: Env,
  shopId: number,
  customerId: string,
): Promise<CustomerRedactResult> {
  const apps = await env.DB.prepare(
    `SELECT id FROM applications
     WHERE shop_id = ? AND shopify_customer_id = ?`,
  )
    .bind(shopId, customerId)
    .all<{ id: number }>();
  const appIds = (apps.results ?? []).map(r => r.id);

  let appsDeleted = 0;
  if (appIds.length > 0) {
    const placeholders = appIds.map(() => '?').join(',');
    // application_nudges FK references applications(id); drop them first.
    await env.DB.prepare(
      `DELETE FROM application_nudges WHERE application_id IN (${placeholders})`,
    )
      .bind(...appIds)
      .run();
    const res = await env.DB.prepare(
      `DELETE FROM applications
       WHERE shop_id = ? AND id IN (${placeholders})`,
    )
      .bind(shopId, ...appIds)
      .run();
    appsDeleted = res.meta?.changes ?? 0;
  }

  const customerHash = await hashIdAsync(customerId);
  const dlRes = await env.DB.prepare(
    `DELETE FROM asset_downloads
     WHERE shop_id = ? AND shopify_customer_id = ?`,
  )
    .bind(shopId, customerHash)
    .run();
  const downloadsDeleted = dlRes.meta?.changes ?? 0;

  let r2Deleted = 0;
  for (const appId of appIds) {
    r2Deleted += await deletePrefix(
      env,
      shopId,
      `shops/${shopId}/applications/${appId}/`,
    );
  }

  // KV cache key only exists if the buyer hit the storefront recently; a
  // missing key is fine.
  const kvKey = `tier:${shopId}:${customerHash}`;
  const existed = await env.KV_HOT_CACHE.get(kvKey);
  if (existed !== null) {
    await env.KV_HOT_CACHE.delete(kvKey);
  }

  return {
    applications_deleted: appsDeleted,
    asset_downloads_deleted: downloadsDeleted,
    r2_objects_deleted: r2Deleted,
    kv_keys_deleted: existed !== null ? 1 : 0,
  };
}

export interface ShopRedactResult {
  rows_deleted: Record<string, number>;
  r2_objects_deleted: number;
  kv_keys_deleted: number;
}

/**
 * Delete every byte we hold for this shop. Used for `shop/redact` and the
 * deferred `app_uninstall_purge`. Child rows go first; the `shops` row is
 * last so a partial failure leaves the install record around for retry.
 */
export async function redactShop(env: Env, shopId: number): Promise<ShopRedactResult> {
  const counts: Record<string, number> = {};

  // application_nudges FKs applications(id) — delete via JOIN on shop_id.
  const nudgeRes = await env.DB.prepare(
    `DELETE FROM application_nudges
     WHERE application_id IN (SELECT id FROM applications WHERE shop_id = ?)`,
  )
    .bind(shopId)
    .run();
  counts.application_nudges = nudgeRes.meta?.changes ?? 0;

  // asset_visibility_rules FKs assets(id) — same pattern.
  const avrRes = await env.DB.prepare(
    `DELETE FROM asset_visibility_rules
     WHERE asset_id IN (SELECT id FROM assets WHERE shop_id = ?)`,
  )
    .bind(shopId)
    .run();
  counts.asset_visibility_rules = avrRes.meta?.changes ?? 0;

  const SIMPLE_TABLES = [
    'applications',
    'asset_downloads',
    'assets',
    'asset_folders',
    'company_tier_mappings',
    'tiers',
    'webhook_log',
  ] as const;
  for (const table of SIMPLE_TABLES) {
    const res = await env.DB.prepare(`DELETE FROM ${table} WHERE shop_id = ?`)
      .bind(shopId)
      .run();
    counts[table] = res.meta?.changes ?? 0;
  }

  const r2Deleted = await deletePrefix(env, shopId, `shops/${shopId}/`);

  const kvDeleted = await deleteKvPrefix(env.KV_HOT_CACHE, `tier:${shopId}:`);

  const shopRes = await env.DB.prepare(`DELETE FROM shops WHERE id = ?`)
    .bind(shopId)
    .run();
  counts.shops = shopRes.meta?.changes ?? 0;

  return {
    rows_deleted: counts,
    r2_objects_deleted: r2Deleted,
    kv_keys_deleted: kvDeleted,
  };
}

/**
 * R2 has no native prefix-delete; list 1000 at a time and batch-delete.
 * Every returned key is re-checked against `shop_id` before deletion to
 * prevent a malformed prefix from reaching across tenants.
 */
async function deletePrefix(env: Env, shopId: number, prefix: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.ASSETS_BUCKET.list({ prefix, cursor, limit: 1000 });
    const keys: string[] = [];
    for (const obj of listed.objects) {
      assertKeyBelongsToShop(obj.key, shopId);
      keys.push(obj.key);
    }
    if (keys.length > 0) {
      await env.ASSETS_BUCKET.delete(keys);
      total += keys.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return total;
}

async function deleteKvPrefix(kv: KVNamespace, prefix: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const listed = await kv.list({ prefix, cursor });
    for (const k of listed.keys) {
      await kv.delete(k.name);
      total++;
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return total;
}
