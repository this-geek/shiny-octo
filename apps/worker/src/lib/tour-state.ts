/**
 * First-login tour dismissal state for buyers (Phase 1J §7 Step 4).
 *
 * Stored in KV_SESSIONS under `tour:<shop_id>:<customer_hash>`. The hash is
 * the same SHA-256-hex used elsewhere for log-safe customer ids; we don't
 * persist the raw GID anywhere. Value is the epoch second when the buyer
 * dismissed the tour. Absence = not dismissed yet.
 *
 * TTL is intentionally long (180 days) so reinstalls / browser changes
 * don't re-trigger the tour for buyers who have already seen it. The tour
 * carries only Day-1 stubs for Day-2 features (saved lists, quick order,
 * quotes); refreshing it later when new Day-2 features land is an explicit
 * action — we'd bump the KV namespace prefix to `tour-v2:` and re-show.
 */

import { hashIdAsync } from './logger.js';

const TTL_SECONDS = 180 * 24 * 60 * 60;

function key(shopId: number, customerHash: string): string {
  return `tour:${shopId}:${customerHash}`;
}

export async function hasDismissedTour(
  kv: KVNamespace,
  shopId: number,
  customerId: string,
): Promise<boolean> {
  const hash = await hashIdAsync(customerId);
  const v = await kv.get(key(shopId, hash));
  return v !== null;
}

export async function dismissTour(
  kv: KVNamespace,
  shopId: number,
  customerId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const hash = await hashIdAsync(customerId);
  await kv.put(key(shopId, hash), String(now), { expirationTtl: TTL_SECONDS });
}
