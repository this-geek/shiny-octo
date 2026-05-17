export type DiscountType = 'percent' | 'amount' | 'none';

export interface Tier {
  id: number;
  shop_id: number;
  name: string;
  discount_type: DiscountType;
  discount_value: number;
  min_order_value: number | null;
  min_order_units: number | null;
  free_shipping_threshold: number | null;
  flat_shipping_amount: number | null;
  pickup_only: boolean;
  priority: number;
  deleted_at: number | null;
}

export interface CartLine {
  variant_id: string;
  price: number; // in cents or decimal — caller's responsibility to be consistent
  quantity: number;
  eligible_for_tier: boolean;
}
