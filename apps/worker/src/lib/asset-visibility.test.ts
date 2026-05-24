import { describe, it, expect } from 'vitest';
import { __testing } from './asset-visibility.js';
import type { Asset } from './asset-store.js';

const { assetIsVisibleTo } = __testing;

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 1,
    shop_id: 7,
    folder_id: null,
    type: 'pdf',
    title: 'Price list',
    description: null,
    r2_key: 'shops/7/assets/1/original',
    external_url: null,
    file_size_bytes: 1024,
    mime_type: 'application/pdf',
    visibility_mode: 'all_b2b',
    uploaded_at: 0,
    uploaded_by: 'admin@example.com',
    deleted_at: null,
    ...overrides,
  };
}

describe('assetIsVisibleTo (pure resolution)', () => {
  const b2bBuyer = {
    shop_id: 7,
    shopify_company_id: 'gid://shopify/Company/100',
    tier_id: 3,
    is_b2b: true,
  };

  it('all_b2b: visible to any B2B buyer', () => {
    expect(assetIsVisibleTo(makeAsset(), [], b2bBuyer)).toBe(true);
  });

  it('tiers: matches when buyer.tier_id is in the rule set', () => {
    const visible = assetIsVisibleTo(
      makeAsset({ visibility_mode: 'tiers' }),
      [{ rule_type: 'tier', rule_target_id: '3' }],
      b2bBuyer,
    );
    expect(visible).toBe(true);
  });

  it('tiers: hidden when buyer.tier_id is not in the rule set', () => {
    const visible = assetIsVisibleTo(
      makeAsset({ visibility_mode: 'tiers' }),
      [{ rule_type: 'tier', rule_target_id: '99' }],
      b2bBuyer,
    );
    expect(visible).toBe(false);
  });

  it('tiers: hidden when buyer has no tier mapping', () => {
    const visible = assetIsVisibleTo(
      makeAsset({ visibility_mode: 'tiers' }),
      [{ rule_type: 'tier', rule_target_id: '3' }],
      { ...b2bBuyer, tier_id: null },
    );
    expect(visible).toBe(false);
  });

  it('companies: matches on Company GID', () => {
    const visible = assetIsVisibleTo(
      makeAsset({ visibility_mode: 'companies' }),
      [{ rule_type: 'company', rule_target_id: 'gid://shopify/Company/100' }],
      b2bBuyer,
    );
    expect(visible).toBe(true);
  });

  it('companies: hidden when GID does not match', () => {
    const visible = assetIsVisibleTo(
      makeAsset({ visibility_mode: 'companies' }),
      [{ rule_type: 'company', rule_target_id: 'gid://shopify/Company/200' }],
      b2bBuyer,
    );
    expect(visible).toBe(false);
  });

  it('companies: hidden when buyer has no company', () => {
    const visible = assetIsVisibleTo(
      makeAsset({ visibility_mode: 'companies' }),
      [{ rule_type: 'company', rule_target_id: 'gid://shopify/Company/100' }],
      { ...b2bBuyer, shopify_company_id: null },
    );
    expect(visible).toBe(false);
  });

  it('does not match wrong rule_type even if target string happens to overlap', () => {
    const visible = assetIsVisibleTo(
      makeAsset({ visibility_mode: 'tiers' }),
      [{ rule_type: 'company', rule_target_id: '3' }],
      b2bBuyer,
    );
    expect(visible).toBe(false);
  });
});
