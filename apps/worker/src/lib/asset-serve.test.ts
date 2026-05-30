// Focused tests for the asset download precondition checks. The deeper
// paths (visibility, budget, R2) are covered by their own unit tests in
// asset-visibility.test.ts, bandwidth-counter.test.ts, etc.; this file
// pins the input-validation short-circuits in checkAssetDownloadAccess so
// the probe endpoint can rely on them.

import { describe, it, expect } from 'vitest';
import { checkAssetDownloadAccess } from './asset-serve.js';
import type { BuyerCtx } from './buyer-context.js';
import type { Env } from '../types.js';

function makeBuyer(overrides: Partial<BuyerCtx> = {}): BuyerCtx {
  return {
    shop_id: 7,
    shop_domain: 'demo.myshopify.com',
    customer_id: 'gid://shopify/Customer/1',
    shopify_company_id: 'gid://shopify/Company/100',
    tier_id: 3,
    is_b2b: true,
    ...overrides,
  } as BuyerCtx;
}

// We never reach the env-touching branches in these short-circuit cases,
// so a bare cast is enough — any access on this would throw and fail the
// test loudly, which is the point.
const NEVER_USED_ENV = {} as Env;

describe('checkAssetDownloadAccess input validation', () => {
  it('returns forbidden for non-B2B buyers without touching the DB', async () => {
    const result = await checkAssetDownloadAccess(
      NEVER_USED_ENV,
      makeBuyer({ is_b2b: false }),
      '1',
    );
    expect(result.kind).toBe('forbidden');
  });

  it('returns bad_request for a non-numeric id', async () => {
    const result = await checkAssetDownloadAccess(NEVER_USED_ENV, makeBuyer(), 'abc');
    expect(result.kind).toBe('bad_request');
  });

  it('returns bad_request for a zero id', async () => {
    const result = await checkAssetDownloadAccess(NEVER_USED_ENV, makeBuyer(), '0');
    expect(result.kind).toBe('bad_request');
  });

  it('returns bad_request for a negative id', async () => {
    const result = await checkAssetDownloadAccess(NEVER_USED_ENV, makeBuyer(), '-5');
    expect(result.kind).toBe('bad_request');
  });

  it('returns bad_request for an empty id', async () => {
    const result = await checkAssetDownloadAccess(NEVER_USED_ENV, makeBuyer(), '');
    expect(result.kind).toBe('bad_request');
  });
});
