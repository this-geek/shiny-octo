import type { Tier } from '@b2b/shared';

export interface TierConfigEntry {
  id: number;
  name: string;
  discount_type: Tier['discount_type'];
  discount_value: number;
  min_order_value: number | null;
  min_order_units: number | null;
  free_shipping_threshold: number | null;
  flat_shipping_amount: number | null;
  pickup_only: boolean;
  priority: number;
}

export interface TiersConfigBlob {
  version: 1;
  tiers: TierConfigEntry[];
}

/**
 * Serialise the active tier set into the JSON payload written to the
 * Shop-scoped `b2b.tiers_config` metafield. Functions read this on every
 * cart-transform / cart-validation / delivery-customization invocation,
 * so the shape must stay backwards-compatible (hence the explicit `version`).
 */
export function buildTiersConfig(tiers: Tier[]): TiersConfigBlob {
  return {
    version: 1,
    tiers: tiers
      .filter(t => t.deleted_at === null)
      .map(t => ({
        id: t.id,
        name: t.name,
        discount_type: t.discount_type,
        discount_value: t.discount_value,
        min_order_value: t.min_order_value,
        min_order_units: t.min_order_units,
        free_shipping_threshold: t.free_shipping_threshold,
        flat_shipping_amount: t.flat_shipping_amount,
        pickup_only: t.pickup_only,
        priority: t.priority,
      })),
  };
}

export function parseTiersConfig(raw: string | null | undefined): TiersConfigBlob | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === 1 &&
      Array.isArray((parsed as { tiers?: unknown }).tiers)
    ) {
      return parsed as TiersConfigBlob;
    }
    return null;
  } catch {
    return null;
  }
}

export function findTier(
  config: TiersConfigBlob | null,
  tierId: number,
): TierConfigEntry | null {
  if (!config) return null;
  return config.tiers.find(t => t.id === tierId) ?? null;
}
