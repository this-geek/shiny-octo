export interface CompanyTierMapping {
  shop_id: number;
  shopify_company_id: string;
  tier_id: number;
  credit_limit: number | null;
  updated_at: number;
}

const COMPANY_GID = /^gid:\/\/shopify\/Company\/[0-9]+$/;

export class CompanyMappingValidationError extends Error {}

export function assertCompanyGid(value: string): void {
  if (!COMPANY_GID.test(value)) {
    throw new CompanyMappingValidationError(
      'shopify_company_id must be a Shopify Company GID (gid://shopify/Company/<id>)',
    );
  }
}

function rowToMapping(row: Record<string, unknown>): CompanyTierMapping {
  return {
    shop_id: row.shop_id as number,
    shopify_company_id: row.shopify_company_id as string,
    tier_id: row.tier_id as number,
    credit_limit: (row.credit_limit as number | null) ?? null,
    updated_at: row.updated_at as number,
  };
}

export async function listMappings(
  db: D1Database,
  shopId: number,
): Promise<CompanyTierMapping[]> {
  const result = await db
    .prepare(
      `SELECT shop_id, shopify_company_id, tier_id, credit_limit, updated_at
       FROM company_tier_mappings
       WHERE shop_id = ?
       ORDER BY updated_at DESC`,
    )
    .bind(shopId)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(rowToMapping);
}

export async function getMapping(
  db: D1Database,
  shopId: number,
  shopifyCompanyId: string,
): Promise<CompanyTierMapping | null> {
  const row = await db
    .prepare(
      `SELECT shop_id, shopify_company_id, tier_id, credit_limit, updated_at
       FROM company_tier_mappings
       WHERE shop_id = ? AND shopify_company_id = ?`,
    )
    .bind(shopId, shopifyCompanyId)
    .first<Record<string, unknown>>();
  return row ? rowToMapping(row) : null;
}

export async function upsertMapping(
  db: D1Database,
  shopId: number,
  shopifyCompanyId: string,
  tierId: number,
  creditLimit: number | null,
): Promise<CompanyTierMapping> {
  assertCompanyGid(shopifyCompanyId);
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO company_tier_mappings
         (shop_id, shopify_company_id, tier_id, credit_limit, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (shop_id, shopify_company_id)
       DO UPDATE SET tier_id = excluded.tier_id,
                     credit_limit = excluded.credit_limit,
                     updated_at = excluded.updated_at`,
    )
    .bind(shopId, shopifyCompanyId, tierId, creditLimit, now)
    .run();

  return {
    shop_id: shopId,
    shopify_company_id: shopifyCompanyId,
    tier_id: tierId,
    credit_limit: creditLimit,
    updated_at: now,
  };
}

export async function deleteMapping(
  db: D1Database,
  shopId: number,
  shopifyCompanyId: string,
): Promise<boolean> {
  assertCompanyGid(shopifyCompanyId);
  const res = await db
    .prepare(
      `DELETE FROM company_tier_mappings
       WHERE shop_id = ? AND shopify_company_id = ?`,
    )
    .bind(shopId, shopifyCompanyId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
