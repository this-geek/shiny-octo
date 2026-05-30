import type { PriceDisplaySettings } from './settings.js';

/**
 * Shape written to the Shop-scoped `b2b.price_display` metafield. The
 * `b2b-price` Theme App Embed reads this in Liquid (`shop.metafields.
 * b2b.price_display.value`) to decide whether the tier-price overlay runs
 * site-wide and how it renders. Functions don't read it — it's display-only —
 * but we mirror it the same way as `b2b.tiers_config` so storefront Liquid
 * gets a single authoritative source controlled from app config (DECISIONS #21).
 *
 * Keep backwards-compatible; bump `version` on a breaking change.
 */
export interface PriceDisplayConfigBlob {
  version: 1;
  site_wide: boolean;
  mode: 'replace' | 'alongside';
  show_savings_badge: boolean;
}

const DEFAULTS: PriceDisplayConfigBlob = {
  version: 1,
  site_wide: false,
  mode: 'alongside',
  show_savings_badge: true,
};

/**
 * Project admin `priceDisplay` settings into the metafield blob. When the
 * merchant has never configured it, emit the safe default (overlay off), so
 * the storefront falls back to the PDP-only behaviour.
 */
export function buildPriceDisplayConfig(
  settings: PriceDisplaySettings | undefined,
): PriceDisplayConfigBlob {
  if (!settings) return { ...DEFAULTS };
  return {
    version: 1,
    site_wide: settings.siteWide,
    mode: settings.mode,
    show_savings_badge: settings.showSavingsBadge,
  };
}
