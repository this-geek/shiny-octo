/**
 * cart-validation Shopify Function — Phase 1F
 *
 * Plus-mode gate identical to cart-transform.
 *
 * Per-line constraints come from Product metafields:
 *   b2b.case_quantity   — order quantity must be a multiple of this
 *   b2b.min_order_qty   — per-line minimum
 *   b2b.max_order_qty   — per-line maximum
 *
 * Cart-level constraints come from the buyer's tier in `b2b.tiers_config`:
 *   tier.min_order_value  — minimum total cart value (after discount)
 *   tier.min_order_units  — minimum eligible unit count
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
  min_order_value: number | null;
  min_order_units: number | null;
}

interface TiersConfigBlob {
  version: number;
  tiers: TierConfigEntry[];
}

interface ProductMetafields {
  caseQuantity: MetafieldValue | null;
  minOrderQty: MetafieldValue | null;
  maxOrderQty: MetafieldValue | null;
}

export interface ValidationLine {
  id: string;
  quantity: number;
  cost: { amountPerQuantity: { amount: string | number } };
  merchandise: {
    title?: string;
    product: ProductMetafields;
  };
}

export interface FunctionInput {
  shop: {
    isPlus: MetafieldValue | null;
    tiersConfig: MetafieldValue | null;
  };
  cart: {
    lines: ValidationLine[];
    buyerIdentity?: {
      purchasingCompany?: {
        company?: { metafield: MetafieldValue | null } | null;
      } | null;
    } | null;
  };
}

interface ValidationError {
  message: string;
  target: string;
}

export interface FunctionResult {
  errors: ValidationError[];
}

const NO_ERRORS: FunctionResult = { errors: [] };

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

function lineBasePrice(line: ValidationLine): number {
  const amt = line.cost.amountPerQuantity.amount;
  return typeof amt === 'number' ? amt : Number.parseFloat(amt);
}

export function run(input: FunctionInput): FunctionResult {
  if (input.shop.isPlus?.value === 'true') return NO_ERRORS;

  const errors: ValidationError[] = [];

  for (const line of input.cart.lines) {
    const lineTitle = line.merchandise.title ?? 'item';
    const caseQty = parsePositiveInt(line.merchandise.product.caseQuantity?.value);
    const minQty = parsePositiveInt(line.merchandise.product.minOrderQty?.value);
    const maxQty = parsePositiveInt(line.merchandise.product.maxOrderQty?.value);

    if (caseQty !== null && line.quantity % caseQty !== 0) {
      errors.push({
        message: `${lineTitle} must be ordered in multiples of ${caseQty}.`,
        target: line.id,
      });
    }
    if (minQty !== null && line.quantity < minQty) {
      errors.push({
        message: `${lineTitle} has a minimum order quantity of ${minQty}.`,
        target: line.id,
      });
    }
    if (maxQty !== null && line.quantity > maxQty) {
      errors.push({
        message: `${lineTitle} has a maximum order quantity of ${maxQty}.`,
        target: line.id,
      });
    }
  }

  const config = parseTiersConfig(input.shop.tiersConfig?.value);
  const tierId = parsePositiveInt(
    input.cart.buyerIdentity?.purchasingCompany?.company?.metafield?.value,
  );
  const tier =
    config && tierId !== null ? (config.tiers.find(t => t.id === tierId) ?? null) : null;

  if (tier) {
    let totalAfter = 0;
    let eligibleUnits = 0;
    for (const line of input.cart.lines) {
      const base = lineBasePrice(line);
      if (!Number.isFinite(base) || base <= 0) continue;
      const discounted = tier.discount_type === 'none' ? base : applyTierDiscount(base, tier);
      totalAfter += discounted * line.quantity;
      eligibleUnits += line.quantity;
    }

    if (tier.min_order_value !== null && totalAfter < tier.min_order_value) {
      errors.push({
        message: `Minimum order value for the ${tier.name} tier is ${tier.min_order_value.toFixed(2)}; your cart total is ${totalAfter.toFixed(2)}.`,
        target: '$.cart',
      });
    }
    if (tier.min_order_units !== null && eligibleUnits < tier.min_order_units) {
      errors.push({
        message: `Minimum order units for the ${tier.name} tier is ${tier.min_order_units}; you have ${eligibleUnits}.`,
        target: '$.cart',
      });
    }
  }

  return { errors };
}
