/**
 * Server-side asset visibility resolution.
 *
 * Every signed-URL request (and every list call) re-resolves visibility from
 * D1 — never trust client claims. The buyer's identity comes from the App
 * Proxy's `logged_in_customer_id` (which Shopify signs); we resolve that to
 * Company GID + tier_id via the same code path tier-context uses.
 *
 * Folder visibility: documented for v1 as advisory only — the asset's own
 * visibility wins. Putting an `all_b2b` asset in a `companies`-restricted
 * folder means it's still visible to all B2B (the folder restricts what shows
 * up in the *list*, not what can be downloaded). Folder ACL composition can
 * land in a follow-up if a merchant actually asks for it.
 */

import type { Asset } from './asset-store.js';

export interface BuyerContext {
  shop_id: number;
  shopify_company_id: string | null;
  tier_id: number | null;
  is_b2b: boolean;
}

export async function listVisibleAssets(
  db: D1Database,
  buyer: BuyerContext,
): Promise<Asset[]> {
  if (!buyer.is_b2b) return [];

  // We over-fetch (every active asset) and filter in JS rather than building a
  // gnarly OR/EXISTS query. Pilot data volumes are <<10k assets/shop; revisit
  // when a shop crosses ~5k assets and the per-request payload starts to bite.
  const result = await db
    .prepare(
      `SELECT a.id, a.shop_id, a.folder_id, a.type, a.title, a.description,
              a.r2_key, a.external_url, a.file_size_bytes, a.mime_type,
              a.visibility_mode, a.uploaded_at, a.uploaded_by, a.deleted_at
       FROM assets a
       WHERE a.shop_id = ? AND a.deleted_at IS NULL
       ORDER BY a.uploaded_at DESC`,
    )
    .bind(buyer.shop_id)
    .all<Record<string, unknown>>();

  const assets = (result.results ?? []).map(rowToAsset);
  const restricted = assets.filter(a => a.visibility_mode !== 'all_b2b').map(a => a.id);
  const ruleMap = await loadRulesFor(db, restricted);

  return assets.filter(a => assetIsVisibleTo(a, ruleMap.get(a.id) ?? [], buyer));
}

export async function isAssetVisible(
  db: D1Database,
  asset: Asset,
  buyer: BuyerContext,
): Promise<boolean> {
  if (!buyer.is_b2b) return false;
  if (asset.deleted_at !== null) return false;
  if (asset.shop_id !== buyer.shop_id) return false;
  if (asset.visibility_mode === 'all_b2b') return true;

  const rules = await loadRulesFor(db, [asset.id]);
  return assetIsVisibleTo(asset, rules.get(asset.id) ?? [], buyer);
}

interface Rule {
  rule_type: 'tier' | 'company';
  rule_target_id: string;
}

function assetIsVisibleTo(asset: Asset, rules: Rule[], buyer: BuyerContext): boolean {
  if (asset.visibility_mode === 'all_b2b') return true;
  if (asset.visibility_mode === 'tiers') {
    if (buyer.tier_id === null) return false;
    return rules.some(
      r => r.rule_type === 'tier' && r.rule_target_id === String(buyer.tier_id),
    );
  }
  if (asset.visibility_mode === 'companies') {
    if (!buyer.shopify_company_id) return false;
    return rules.some(
      r => r.rule_type === 'company' && r.rule_target_id === buyer.shopify_company_id,
    );
  }
  return false;
}

async function loadRulesFor(
  db: D1Database,
  assetIds: number[],
): Promise<Map<number, Rule[]>> {
  const out = new Map<number, Rule[]>();
  if (assetIds.length === 0) return out;
  // D1 SQLite parameter limit is 100 — chunk to stay well under that.
  const CHUNK = 90;
  for (let i = 0; i < assetIds.length; i += CHUNK) {
    const slice = assetIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const result = await db
      .prepare(
        `SELECT asset_id, rule_type, rule_target_id
         FROM asset_visibility_rules
         WHERE asset_id IN (${placeholders})`,
      )
      .bind(...slice)
      .all<Record<string, unknown>>();
    for (const row of result.results ?? []) {
      const assetId = row.asset_id as number;
      const list = out.get(assetId) ?? [];
      list.push({
        rule_type: row.rule_type as 'tier' | 'company',
        rule_target_id: row.rule_target_id as string,
      });
      out.set(assetId, list);
    }
  }
  return out;
}

function rowToAsset(row: Record<string, unknown>): Asset {
  return {
    id: row.id as number,
    shop_id: row.shop_id as number,
    folder_id: (row.folder_id as number | null) ?? null,
    type: row.type as Asset['type'],
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    r2_key: (row.r2_key as string | null) ?? null,
    external_url: (row.external_url as string | null) ?? null,
    file_size_bytes: (row.file_size_bytes as number | null) ?? null,
    mime_type: (row.mime_type as string | null) ?? null,
    visibility_mode: row.visibility_mode as Asset['visibility_mode'],
    uploaded_at: row.uploaded_at as number,
    uploaded_by: row.uploaded_by as string,
    deleted_at: (row.deleted_at as number | null) ?? null,
  };
}

// Exposed for the test suite — pure resolution logic against a known rule set.
export const __testing = { assetIsVisibleTo };
