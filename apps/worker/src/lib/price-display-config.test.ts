import { describe, it, expect } from 'vitest';
import { buildPriceDisplayConfig } from './price-display-config.js';

describe('buildPriceDisplayConfig', () => {
  it('emits the safe default (overlay off) when settings are absent', () => {
    expect(buildPriceDisplayConfig(undefined)).toEqual({
      version: 1,
      site_wide: false,
      mode: 'alongside',
      show_savings_badge: true,
    });
  });

  it('projects the merchant settings into the metafield blob', () => {
    expect(
      buildPriceDisplayConfig({ siteWide: true, mode: 'replace', showSavingsBadge: false }),
    ).toEqual({
      version: 1,
      site_wide: true,
      mode: 'replace',
      show_savings_badge: false,
    });
  });

  it('always stamps version 1 for forwards-compatible parsing', () => {
    expect(buildPriceDisplayConfig({ siteWide: true, mode: 'alongside', showSavingsBadge: true }).version).toBe(1);
  });
});
