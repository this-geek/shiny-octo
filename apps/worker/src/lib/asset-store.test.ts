import { describe, it, expect } from 'vitest';
import {
  AssetValidationError,
  validateAssetInput,
  validateRulesAgainstMode,
} from './asset-store.js';

describe('validateAssetInput', () => {
  const baseImage = {
    folder_id: null,
    type: 'image' as const,
    title: 'Catalog 2026',
    description: null,
    r2_key: 'shops/1/assets/1/original',
    external_url: null,
    file_size_bytes: 1024,
    mime_type: 'image/jpeg',
    visibility_mode: 'all_b2b' as const,
    uploaded_by: 'merchant@example.com',
  };

  it('accepts a minimal image asset', () => {
    expect(() => validateAssetInput(baseImage)).not.toThrow();
  });

  it('rejects an image asset without r2_key', () => {
    expect(() => validateAssetInput({ ...baseImage, r2_key: null })).toThrow(
      AssetValidationError,
    );
  });

  it('requires external_url for link assets', () => {
    expect(() =>
      validateAssetInput({
        ...baseImage,
        type: 'link',
        r2_key: null,
        external_url: null,
      }),
    ).toThrow(AssetValidationError);
  });

  it('rejects http(s)-less external_url', () => {
    expect(() =>
      validateAssetInput({
        ...baseImage,
        type: 'link',
        r2_key: null,
        external_url: 'javascript:alert(1)',
      }),
    ).toThrow(AssetValidationError);
  });

  it('rejects a link asset that carries an r2_key', () => {
    expect(() =>
      validateAssetInput({
        ...baseImage,
        type: 'link',
        r2_key: 'shops/1/assets/1/original',
        external_url: 'https://drive.example.com/x',
      }),
    ).toThrow(AssetValidationError);
  });

  it('rejects non-link asset that carries an external_url', () => {
    expect(() =>
      validateAssetInput({
        ...baseImage,
        external_url: 'https://example.com',
      }),
    ).toThrow(AssetValidationError);
  });

  it('rejects an empty title', () => {
    expect(() => validateAssetInput({ ...baseImage, title: '   ' })).toThrow(
      AssetValidationError,
    );
  });

  it('rejects an unknown type', () => {
    expect(() => validateAssetInput({ ...baseImage, type: 'audio' })).toThrow(
      AssetValidationError,
    );
  });

  it('rejects a negative file_size_bytes', () => {
    expect(() => validateAssetInput({ ...baseImage, file_size_bytes: -1 })).toThrow(
      AssetValidationError,
    );
  });

  it('rejects an unknown visibility_mode', () => {
    expect(() => validateAssetInput({ ...baseImage, visibility_mode: 'public' })).toThrow(
      AssetValidationError,
    );
  });
});

describe('validateRulesAgainstMode', () => {
  it('all_b2b: rules must be empty', () => {
    expect(() => validateRulesAgainstMode('all_b2b', [])).not.toThrow();
    expect(() =>
      validateRulesAgainstMode('all_b2b', [{ rule_type: 'tier', rule_target_id: '1' }]),
    ).toThrow(AssetValidationError);
  });

  it('tiers: needs ≥1 rule, all of type tier', () => {
    expect(() => validateRulesAgainstMode('tiers', [])).toThrow(AssetValidationError);
    expect(() =>
      validateRulesAgainstMode('tiers', [{ rule_type: 'tier', rule_target_id: '1' }]),
    ).not.toThrow();
    expect(() =>
      validateRulesAgainstMode('tiers', [
        { rule_type: 'tier', rule_target_id: '1' },
        { rule_type: 'company', rule_target_id: 'gid://shopify/Company/1' },
      ]),
    ).toThrow(AssetValidationError);
  });

  it('companies: needs ≥1 rule, all of type company', () => {
    expect(() => validateRulesAgainstMode('companies', [])).toThrow(AssetValidationError);
    expect(() =>
      validateRulesAgainstMode('companies', [
        { rule_type: 'company', rule_target_id: 'gid://shopify/Company/1' },
      ]),
    ).not.toThrow();
  });

  it('rejects empty rule_target_id', () => {
    expect(() =>
      validateRulesAgainstMode('tiers', [{ rule_type: 'tier', rule_target_id: '' }]),
    ).toThrow(AssetValidationError);
  });
});
