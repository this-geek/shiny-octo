import { describe, it, expect } from 'vitest';
import { assertCompanyGid, CompanyMappingValidationError } from './company-mapping-store.js';

describe('assertCompanyGid', () => {
  it('accepts a valid Shopify Company GID', () => {
    expect(() => assertCompanyGid('gid://shopify/Company/12345')).not.toThrow();
  });

  it('rejects a bare numeric id', () => {
    expect(() => assertCompanyGid('12345')).toThrow(CompanyMappingValidationError);
  });

  it('rejects a Customer GID (wrong type)', () => {
    expect(() => assertCompanyGid('gid://shopify/Customer/12345')).toThrow(
      CompanyMappingValidationError,
    );
  });

  it('rejects empty input', () => {
    expect(() => assertCompanyGid('')).toThrow(CompanyMappingValidationError);
  });

  it('rejects path traversal attempts', () => {
    expect(() => assertCompanyGid('gid://shopify/Company/12;DROP TABLE')).toThrow(
      CompanyMappingValidationError,
    );
  });
});
