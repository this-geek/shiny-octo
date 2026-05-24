/**
 * cart-transform Shopify Function — Phase 1D
 *
 * Plus-mode invariant (DECISIONS / §3): when `shop.metafield(b2b.is_plus)`
 * is "true" we early-return. Plus has unlimited native Catalogs assigned
 * directly to Company Locations; our Function would double-apply discounts.
 *
 * Reads `b2b.tiers_config` (Shop) and `b2b.tier_id` (Company) and emits a
 * fixed-per-unit price override per cart line using the same pricing math
 * as @b2b/shared (so the storefront PDP refinement, this Function, and any
 * future preview UI cannot drift).
 */

import { applyTierDiscount } from '@b2b/shared';
import type { DiscountType } from '@b2b/shared';

interface MetafieldValue {
  value: string;
}

interface TierConfigEntry {
  id: number;
  name: string;
  discount_type: DiscountType;
  discount_value: number;
}

interface TiersConfigBlob {
  version: number;
  tiers: TierConfigEntry[];
}

export interface FunctionInput {
  shop: {
    isPlus: MetafieldValue | null;
    tiersConfig: MetafieldValue | null;
  };
  cart: {
    lines: Array<{
      id: string;
      quantity: number;
      cost: { amountPerQuantity: { amount: string | number } };
    }>;
    buyerIdentity?: {
      purchasingCompany?: {
        company?: { metafield: MetafieldValue | null } | null;
      } | null;
    } | null;
  };
}

interface UpdateOperation {
  update: {
    cartLineId: string;
    price: {
      adjustment: {
        fixedPricePerUnit: { amount: string };
      };
    };
  };
}

export interface FunctionResult {
  operations: UpdateOperation[];
}

const NO_OPS: FunctionResult = { operations: [] };

function parseTiersConfig(raw: string | null | undefined): TiersConfigBlob | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as { tiers?: unknown }).tiers)
    ) {
      return parsed as TiersConfigBlob;
    }
    return null;
  } catch {
    return null;
  }
}

function parseTierId(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

export function run(input: FunctionInput): FunctionResult {
  // Plus-mode early return — keeps us out of shops where native Catalogs
  // do tier pricing.
  if (input.shop.isPlus?.value === 'true') return NO_OPS;

  const config = parseTiersConfig(input.shop.tiersConfig?.value);
  if (!config) return NO_OPS;

  const tierId = parseTierId(
    input.cart.buyerIdentity?.purchasingCompany?.company?.metafield?.value,
  );
  if (tierId === null) return NO_OPS;

  const tier = config.tiers.find(t => t.id === tierId);
  if (!tier) return NO_OPS;
  if (tier.discount_type === 'none') return NO_OPS;

  const operations: UpdateOperation[] = [];
  for (const line of input.cart.lines) {
    const basePrice =
      typeof line.cost.amountPerQuantity.amount === 'number'
        ? line.cost.amountPerQuantity.amount
        : Number.parseFloat(line.cost.amountPerQuantity.amount);
    if (!Number.isFinite(basePrice) || basePrice <= 0) continue;

    const newPrice = applyTierDiscount(basePrice, tier);
    if (newPrice >= basePrice) continue;

    operations.push({
      update: {
        cartLineId: line.id,
        price: {
          adjustment: {
            fixedPricePerUnit: { amount: formatAmount(newPrice) },
          },
        },
      },
    });
  }

  return { operations };
}
