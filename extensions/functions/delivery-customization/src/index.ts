/**
 * delivery-customization Shopify Function — Phase 1G
 *
 * Plus-mode gate identical to cart-transform.
 *
 * Reads `b2b.tiers_config` (Shop) and `b2b.tier_id` (Company) to apply
 * per-tier delivery rules:
 *   - pickup_only            → hide every non-pickup delivery option
 *   - free_shipping_threshold → rename matching options to "Free shipping"
 *                              when cart subtotal (after tier discount,
 *                              excluding tax) ≥ threshold
 *   - flat_shipping_amount   → rename options to advertise the flat rate
 *
 * Operation precedence: pickup_only > free_shipping_threshold > flat_shipping_amount.
 *
 * The delivery-customization API only supports `hide` and `rename` (and
 * `moveOperation`) — it cannot change a rate's price. Actually zeroing
 * the rate for free-shipping or overriding it for flat-rate requires
 * pairing this Function with a delivery-discount Function or with merchant
 * shipping-zone configuration. The rename here is the user-visible signal;
 * the price adjustment is a follow-up phase.
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
  free_shipping_threshold: number | null;
  flat_shipping_amount: number | null;
  pickup_only: boolean;
}

interface TiersConfigBlob {
  version: number;
  tiers: TierConfigEntry[];
}

export interface DeliveryOption {
  handle: string;
  title?: string;
  type?: 'pickup' | 'shipping' | string;
  cost?: { amount: string | number } | null;
}

export interface DeliveryGroup {
  id: string;
  deliveryOptions: DeliveryOption[];
}

export interface CartLineForShipping {
  quantity: number;
  cost: { amountPerQuantity: { amount: string | number } };
}

export interface FunctionInput {
  shop: {
    isPlus: MetafieldValue | null;
    tiersConfig: MetafieldValue | null;
  };
  cart: {
    lines: CartLineForShipping[];
    deliveryGroups: DeliveryGroup[];
    buyerIdentity?: {
      purchasingCompany?: {
        company?: { metafield: MetafieldValue | null } | null;
      } | null;
    } | null;
  };
}

type Operation =
  | { hide: { deliveryOptionHandle: string } }
  | { rename: { deliveryOptionHandle: string; title: string } }
  | { moveOperation?: never };

export interface FunctionResult {
  operations: Operation[];
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

function parsePositiveInt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function cartSubtotalAfterDiscount(
  lines: CartLineForShipping[],
  tier: TierConfigEntry,
): number {
  let total = 0;
  for (const line of lines) {
    const amt = line.cost.amountPerQuantity.amount;
    const base = typeof amt === 'number' ? amt : Number.parseFloat(amt);
    if (!Number.isFinite(base) || base <= 0) continue;
    const discounted =
      tier.discount_type === 'none' ? base : applyTierDiscount(base, tier);
    total += discounted * line.quantity;
  }
  return total;
}

function isPickup(option: DeliveryOption): boolean {
  if (option.type === 'pickup') return true;
  const title = (option.title ?? '').toLowerCase();
  return title.includes('pickup') || title.includes('pick up') || title.includes('collect');
}

export function run(input: FunctionInput): FunctionResult {
  if (input.shop.isPlus?.value === 'true') return NO_OPS;

  const config = parseTiersConfig(input.shop.tiersConfig?.value);
  const tierId = parsePositiveInt(
    input.cart.buyerIdentity?.purchasingCompany?.company?.metafield?.value,
  );
  const tier =
    config && tierId !== null ? (config.tiers.find(t => t.id === tierId) ?? null) : null;
  if (!tier) return NO_OPS;

  const operations: Operation[] = [];

  if (tier.pickup_only) {
    for (const group of input.cart.deliveryGroups) {
      for (const option of group.deliveryOptions) {
        if (!isPickup(option)) {
          operations.push({ hide: { deliveryOptionHandle: option.handle } });
        }
      }
    }
    return { operations };
  }

  const subtotal = cartSubtotalAfterDiscount(input.cart.lines, tier);
  const freeShipping =
    tier.free_shipping_threshold !== null && subtotal >= tier.free_shipping_threshold;

  if (freeShipping) {
    for (const group of input.cart.deliveryGroups) {
      for (const option of group.deliveryOptions) {
        if (!isPickup(option)) {
          operations.push({
            rename: { deliveryOptionHandle: option.handle, title: 'Free shipping' },
          });
        }
      }
    }
    return { operations };
  }

  if (tier.flat_shipping_amount !== null) {
    for (const group of input.cart.deliveryGroups) {
      for (const option of group.deliveryOptions) {
        if (!isPickup(option)) {
          const flatLabel = `Flat-rate shipping (${tier.flat_shipping_amount.toFixed(2)})`;
          operations.push({
            rename: { deliveryOptionHandle: option.handle, title: flatLabel },
          });
        }
      }
    }
  }

  return { operations };
}
