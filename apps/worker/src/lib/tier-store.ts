import type { Tier, DiscountType } from '@b2b/shared';

const DISCOUNT_TYPES: ReadonlyArray<DiscountType> = ['percent', 'amount', 'none'];

export class TierValidationError extends Error {}

export interface TierInput {
  name: string;
  discount_type: DiscountType;
  discount_value: number;
  min_order_value: number | null;
  min_order_units: number | null;
  free_shipping_threshold: number | null;
  flat_shipping_amount: number | null;
  pickup_only: boolean;
  priority: number;
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function parseNullableNumber(v: unknown, label: string): number | null {
  if (v === null || v === undefined) return null;
  if (!isFiniteNonNegative(v)) {
    throw new TierValidationError(`${label} must be a finite non-negative number or null`);
  }
  return v;
}

export function validateTierInput(input: unknown): TierInput {
  if (typeof input !== 'object' || input === null) {
    throw new TierValidationError('tier payload must be an object');
  }
  const t = input as Record<string, unknown>;

  if (typeof t.name !== 'string' || t.name.length === 0 || t.name.length > 100) {
    throw new TierValidationError('name must be 1-100 chars');
  }
  if (
    typeof t.discount_type !== 'string' ||
    !(DISCOUNT_TYPES as readonly string[]).includes(t.discount_type)
  ) {
    throw new TierValidationError(`discount_type must be one of ${DISCOUNT_TYPES.join(', ')}`);
  }
  if (!isFiniteNonNegative(t.discount_value)) {
    throw new TierValidationError('discount_value must be a finite non-negative number');
  }
  if (t.discount_type === 'percent' && (t.discount_value as number) > 100) {
    throw new TierValidationError('discount_value cannot exceed 100 when discount_type=percent');
  }
  if (typeof t.pickup_only !== 'boolean') {
    throw new TierValidationError('pickup_only must be boolean');
  }
  if (!Number.isInteger(t.priority) || (t.priority as number) < 0) {
    throw new TierValidationError('priority must be a non-negative integer');
  }

  return {
    name: t.name,
    discount_type: t.discount_type as DiscountType,
    discount_value: t.discount_value as number,
    min_order_value: parseNullableNumber(t.min_order_value, 'min_order_value'),
    min_order_units: parseNullableNumber(t.min_order_units, 'min_order_units'),
    free_shipping_threshold: parseNullableNumber(
      t.free_shipping_threshold,
      'free_shipping_threshold',
    ),
    flat_shipping_amount: parseNullableNumber(t.flat_shipping_amount, 'flat_shipping_amount'),
    pickup_only: t.pickup_only,
    priority: t.priority as number,
  };
}

function rowToTier(row: Record<string, unknown>): Tier {
  return {
    id: row.id as number,
    shop_id: row.shop_id as number,
    name: row.name as string,
    discount_type: row.discount_type as DiscountType,
    discount_value: row.discount_value as number,
    min_order_value: (row.min_order_value as number | null) ?? null,
    min_order_units: (row.min_order_units as number | null) ?? null,
    free_shipping_threshold: (row.free_shipping_threshold as number | null) ?? null,
    flat_shipping_amount: (row.flat_shipping_amount as number | null) ?? null,
    pickup_only: Number(row.pickup_only) === 1,
    priority: row.priority as number,
    deleted_at: (row.deleted_at as number | null) ?? null,
  };
}

export async function listActiveTiers(db: D1Database, shopId: number): Promise<Tier[]> {
  const result = await db
    .prepare(
      `SELECT id, shop_id, name, discount_type, discount_value,
              min_order_value, min_order_units, free_shipping_threshold,
              flat_shipping_amount, pickup_only, priority, deleted_at
       FROM tiers
       WHERE shop_id = ? AND deleted_at IS NULL
       ORDER BY priority ASC, id ASC`,
    )
    .bind(shopId)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(rowToTier);
}

export async function getTier(
  db: D1Database,
  shopId: number,
  tierId: number,
): Promise<Tier | null> {
  const row = await db
    .prepare(
      `SELECT id, shop_id, name, discount_type, discount_value,
              min_order_value, min_order_units, free_shipping_threshold,
              flat_shipping_amount, pickup_only, priority, deleted_at
       FROM tiers
       WHERE shop_id = ? AND id = ?`,
    )
    .bind(shopId, tierId)
    .first<Record<string, unknown>>();
  return row ? rowToTier(row) : null;
}

export async function createTier(
  db: D1Database,
  shopId: number,
  input: TierInput,
): Promise<Tier> {
  const result = await db
    .prepare(
      `INSERT INTO tiers (
         shop_id, name, discount_type, discount_value,
         min_order_value, min_order_units, free_shipping_threshold,
         flat_shipping_amount, pickup_only, priority
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      shopId,
      input.name,
      input.discount_type,
      input.discount_value,
      input.min_order_value,
      input.min_order_units,
      input.free_shipping_threshold,
      input.flat_shipping_amount,
      input.pickup_only ? 1 : 0,
      input.priority,
    )
    .first<{ id: number }>();

  if (!result) throw new Error('createTier: no row returned');
  return {
    id: result.id,
    shop_id: shopId,
    ...input,
    deleted_at: null,
  };
}

export async function updateTier(
  db: D1Database,
  shopId: number,
  tierId: number,
  input: TierInput,
): Promise<Tier | null> {
  const res = await db
    .prepare(
      `UPDATE tiers SET
         name = ?, discount_type = ?, discount_value = ?,
         min_order_value = ?, min_order_units = ?,
         free_shipping_threshold = ?, flat_shipping_amount = ?,
         pickup_only = ?, priority = ?
       WHERE shop_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .bind(
      input.name,
      input.discount_type,
      input.discount_value,
      input.min_order_value,
      input.min_order_units,
      input.free_shipping_threshold,
      input.flat_shipping_amount,
      input.pickup_only ? 1 : 0,
      input.priority,
      shopId,
      tierId,
    )
    .run();

  if ((res.meta?.changes ?? 0) === 0) return null;
  return getTier(db, shopId, tierId);
}

/**
 * Soft delete: mapping rows still reference this tier so their FK stays valid.
 * Functions skip tiers with deleted_at !== null when reading b2b.tiers_config.
 */
export async function softDeleteTier(
  db: D1Database,
  shopId: number,
  tierId: number,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare(
      `UPDATE tiers SET deleted_at = ?
       WHERE shop_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .bind(now, shopId, tierId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
