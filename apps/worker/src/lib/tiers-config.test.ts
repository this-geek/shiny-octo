import { describe, it, expect } from 'vitest';
import type { Tier } from '@b2b/shared';
import { buildTiersConfig, findTier, parseTiersConfig } from './tiers-config.js';

function tier(overrides: Partial<Tier> = {}): Tier {
  return {
    id: 1,
    shop_id: 100,
    name: 'Gold',
    discount_type: 'percent',
    discount_value: 10,
    min_order_value: null,
    min_order_units: null,
    free_shipping_threshold: null,
    flat_shipping_amount: null,
    pickup_only: false,
    priority: 0,
    deleted_at: null,
    ...overrides,
  };
}

describe('buildTiersConfig', () => {
  it('versions the payload as 1', () => {
    expect(buildTiersConfig([]).version).toBe(1);
  });

  it('omits soft-deleted tiers', () => {
    const config = buildTiersConfig([
      tier({ id: 1 }),
      tier({ id: 2, deleted_at: 1000 }),
      tier({ id: 3 }),
    ]);
    expect(config.tiers.map(t => t.id)).toEqual([1, 3]);
  });

  it('does not leak shop_id into the public payload', () => {
    const config = buildTiersConfig([tier()]);
    expect(config.tiers[0]).not.toHaveProperty('shop_id');
    expect(config.tiers[0]).not.toHaveProperty('deleted_at');
  });
});

describe('parseTiersConfig', () => {
  it('returns null for null/undefined/empty input', () => {
    expect(parseTiersConfig(null)).toBeNull();
    expect(parseTiersConfig(undefined)).toBeNull();
    expect(parseTiersConfig('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseTiersConfig('not json')).toBeNull();
  });

  it('returns null for the wrong version', () => {
    expect(parseTiersConfig(JSON.stringify({ version: 99, tiers: [] }))).toBeNull();
  });

  it('round-trips a valid config', () => {
    const original = buildTiersConfig([tier({ id: 7, name: 'Platinum' })]);
    const parsed = parseTiersConfig(JSON.stringify(original));
    expect(parsed?.tiers).toHaveLength(1);
    expect(parsed?.tiers[0].name).toBe('Platinum');
  });
});

describe('findTier', () => {
  it('returns null for missing tier', () => {
    const config = buildTiersConfig([tier({ id: 1 })]);
    expect(findTier(config, 999)).toBeNull();
  });

  it('returns the matching tier by id', () => {
    const config = buildTiersConfig([tier({ id: 1 }), tier({ id: 2, name: 'Silver' })]);
    expect(findTier(config, 2)?.name).toBe('Silver');
  });

  it('returns null when config is null', () => {
    expect(findTier(null, 1)).toBeNull();
  });
});
