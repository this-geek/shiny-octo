import { describe, it, expect } from 'vitest';
import { run, type FunctionInput } from './index.js';

describe('cart-validation Function', () => {
  it('returns empty errors when shop.metafield.value === "true" (Plus)', () => {
    const input: FunctionInput = { shop: { metafield: { value: 'true' } } };
    expect(run(input)).toEqual({ errors: [] });
  });

  it('returns empty errors when shop.metafield is null (non-Plus, Phase 1A scaffold)', () => {
    const input: FunctionInput = { shop: { metafield: null } };
    expect(run(input)).toEqual({ errors: [] });
  });

  it('returns empty errors when shop.metafield.value === "false" (non-Plus, Phase 1A scaffold)', () => {
    const input: FunctionInput = { shop: { metafield: { value: 'false' } } };
    expect(run(input)).toEqual({ errors: [] });
  });
});
