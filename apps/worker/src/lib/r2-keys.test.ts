import { describe, it, expect } from 'vitest';
import {
  assertKeyBelongsToShop,
  assetKey,
  inferAssetType,
  isMimeAllowed,
  isSizeWithinLimit,
  uploadSessionPrefix,
} from './r2-keys.js';

describe('r2-keys', () => {
  it('assetKey is shop-scoped', () => {
    expect(assetKey(7, 42, 'original')).toBe('shops/7/assets/42/original');
  });

  it('uploadSessionPrefix is shop-scoped', () => {
    expect(uploadSessionPrefix(7, 'abc')).toBe('shops/7/uploads/abc');
  });

  it('assertKeyBelongsToShop throws for cross-tenant keys', () => {
    expect(() => assertKeyBelongsToShop('shops/8/assets/1/original', 7)).toThrow();
    expect(() => assertKeyBelongsToShop('shops/7/assets/1/original', 7)).not.toThrow();
  });

  it('infers asset type from mime', () => {
    expect(inferAssetType('image/jpeg')).toBe('image');
    expect(inferAssetType('application/pdf')).toBe('pdf');
    expect(inferAssetType('video/mp4')).toBe('video');
    expect(inferAssetType('text/plain')).toBeNull();
    expect(inferAssetType(null)).toBeNull();
  });

  it('rejects disallowed mime', () => {
    expect(isMimeAllowed('application/x-msdownload')).toBe(false);
    expect(isMimeAllowed('image/webp')).toBe(true);
  });

  it('caps video size at 500MB per §4.4', () => {
    expect(isSizeWithinLimit('video', 500 * 1024 * 1024)).toBe(true);
    expect(isSizeWithinLimit('video', 500 * 1024 * 1024 + 1)).toBe(false);
  });

  it('does not cap other types here (bandwidth gate handles those)', () => {
    expect(isSizeWithinLimit('image', 200 * 1024 * 1024)).toBe(true);
    expect(isSizeWithinLimit('pdf', 200 * 1024 * 1024)).toBe(true);
  });
});
