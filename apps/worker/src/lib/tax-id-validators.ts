/**
 * Tax-ID format validators (DECISIONS #12: NZ first, others pluggable).
 *
 * These are format-only checks — we do not call out to government services.
 * The intent is to catch the "8 instead of 9 digits" class of mistake at
 * submit time so the merchant doesn't reject perfectly good applications
 * because of a typo. Real validation happens when the merchant cross-checks
 * a registration during approval.
 *
 * Plug a new country in by adding an entry to COUNTRY_VALIDATORS keyed by
 * lowercase ISO-3166-1 alpha-2 country code.
 */

export type TaxIdValidator = (raw: string) => boolean;

export interface CountryValidators {
  taxId?: TaxIdValidator;
  gstNumber?: TaxIdValidator;
}

function strip(raw: string): string {
  return raw.replace(/[\s\-_.]/g, '');
}

/**
 * NZ IRD number: 8 or 9 digits, mod-11 checksum on the first 7-8 digits.
 * https://www.ird.govt.nz/-/media/project/ir/home/documents/about-us/working-with-tax-agents/data-specifications/2024-irds-information-for-software-providers.pdf
 *
 * We accept both 8- and 9-digit forms because old IRDs are 8 and new ones
 * are 9; both are still valid in production.
 */
export function isValidNzIrd(raw: string): boolean {
  const cleaned = strip(raw);
  if (!/^\d{8,9}$/.test(cleaned)) return false;
  // Pad 8-digit IRDs with a leading zero so the same algorithm works.
  const padded = cleaned.length === 8 ? '0' + cleaned : cleaned;
  const digits = padded.split('').map(Number);
  const body = digits.slice(0, 8);
  const check = digits[8];
  const weights1 = [3, 2, 7, 6, 5, 4, 3, 2];
  const weights2 = [7, 4, 3, 2, 5, 2, 7, 6];
  function compute(weights: number[]): number {
    const sum = body.reduce((s, d, i) => s + d * weights[i], 0);
    const remainder = sum % 11;
    return remainder === 0 ? 0 : 11 - remainder;
  }
  const c1 = compute(weights1);
  if (c1 < 10) return c1 === check;
  const c2 = compute(weights2);
  if (c2 < 10) return c2 === check;
  return false;
}

/**
 * NZ GST number is structurally the same as an IRD; the difference is
 * registration state, not format. We accept any valid IRD.
 */
export const isValidNzGst: TaxIdValidator = isValidNzIrd;

const COUNTRY_VALIDATORS: Record<string, CountryValidators> = {
  nz: { taxId: isValidNzIrd, gstNumber: isValidNzGst },
  // Hook AU/US/EU in here when pilot expands; see DECISIONS #12.
};

export interface TaxIdValidation {
  ok: boolean;
  error: string | null;
}

export function validateTaxId(
  countryCode: string | null | undefined,
  taxId: string | null | undefined,
  options: { field?: 'taxId' | 'gstNumber'; required?: boolean } = {},
): TaxIdValidation {
  const field = options.field ?? 'taxId';
  const required = options.required ?? false;
  const value = (taxId ?? '').trim();

  if (!value) {
    if (required) return { ok: false, error: `${field} is required` };
    return { ok: true, error: null };
  }

  if (!countryCode) {
    // Without a country we cannot pick a validator; accept the format and let
    // the merchant verify manually rather than rejecting at submit.
    return { ok: true, error: null };
  }

  const country = COUNTRY_VALIDATORS[countryCode.toLowerCase()];
  if (!country) {
    // No registered validator for this country yet (DECISIONS #12); accept.
    return { ok: true, error: null };
  }

  const validator = country[field];
  if (!validator) return { ok: true, error: null };

  return validator(value)
    ? { ok: true, error: null }
    : { ok: false, error: `${field} is not a valid ${countryCode.toUpperCase()} format` };
}

export function hasValidator(countryCode: string | null | undefined): boolean {
  if (!countryCode) return false;
  return Object.prototype.hasOwnProperty.call(
    COUNTRY_VALIDATORS,
    countryCode.toLowerCase(),
  );
}
