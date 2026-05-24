import { describe, it, expect } from 'vitest';
import {
  hasValidator,
  isValidNzIrd,
  validateTaxId,
} from './tax-id-validators.js';

describe('isValidNzIrd', () => {
  // Known-valid IRD numbers from public IRD spec test vectors.
  it('accepts canonical 9-digit IRDs with correct check digit', () => {
    expect(isValidNzIrd('49091850')).toBe(true);
    expect(isValidNzIrd('136410132')).toBe(true);
    expect(isValidNzIrd('49098576')).toBe(true);
  });

  it('rejects when the check digit is wrong', () => {
    expect(isValidNzIrd('490918501')).toBe(false);
    expect(isValidNzIrd('136410133')).toBe(false);
  });

  it('rejects non-digit input', () => {
    expect(isValidNzIrd('abc')).toBe(false);
    expect(isValidNzIrd('')).toBe(false);
    expect(isValidNzIrd('123')).toBe(false);
  });

  it('accepts formatted IRDs with separators', () => {
    expect(isValidNzIrd('49-091-850')).toBe(true);
    expect(isValidNzIrd('49 091 850')).toBe(true);
    expect(isValidNzIrd('136-410-132')).toBe(true);
  });

  it('rejects ten-digit numbers (too long for an IRD)', () => {
    expect(isValidNzIrd('1234567890')).toBe(false);
  });
});

describe('validateTaxId', () => {
  it('returns ok when no value supplied and not required', () => {
    expect(validateTaxId('nz', '')).toEqual({ ok: true, error: null });
    expect(validateTaxId('nz', null)).toEqual({ ok: true, error: null });
  });

  it('errors when required and empty', () => {
    const r = validateTaxId('nz', '', { required: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/required/);
  });

  it('accepts unknown country without validating', () => {
    // We have no validator for ZW yet; pass through so we do not reject good
    // applications from countries we have not wired up.
    expect(validateTaxId('zw', 'anything')).toEqual({ ok: true, error: null });
  });

  it('accepts when country is missing', () => {
    expect(validateTaxId(null, '12345')).toEqual({ ok: true, error: null });
  });

  it('rejects invalid NZ IRD', () => {
    // 123456789 fails both weight tables (check digit doesn't match).
    const r = validateTaxId('nz', '123456789');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/NZ/);
  });

  it('accepts valid NZ IRD', () => {
    expect(validateTaxId('nz', '136-410-132').ok).toBe(true);
  });

  it('is case-insensitive on country code', () => {
    expect(validateTaxId('NZ', '136410132').ok).toBe(true);
  });
});

describe('hasValidator', () => {
  it('true for registered countries', () => {
    expect(hasValidator('nz')).toBe(true);
    expect(hasValidator('NZ')).toBe(true);
  });
  it('false for unregistered / missing', () => {
    expect(hasValidator('xx')).toBe(false);
    expect(hasValidator(null)).toBe(false);
    expect(hasValidator(undefined)).toBe(false);
  });
});
