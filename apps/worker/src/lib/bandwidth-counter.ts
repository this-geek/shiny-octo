/**
 * KV-backed monthly bandwidth counter (DECISIONS #14).
 *
 *   bw:<shop_id>:<YYYY-MM>  →  bytes consumed this calendar month (decimal string)
 *
 * Workers KV is eventually consistent and lacks atomic increment, so this
 * counter is best-effort: under heavy concurrent download bursts it can
 * over- or under-count by a few requests' worth of bytes. That's fine for a
 * fair-use ceiling — we're not billing on the number. We round-up the
 * recorded delta to nearest KB to keep the value bounded.
 *
 * On read-side gate: `assertWithinBudget` returns false when the bucket is
 * already at or past the cap; callers should respond 429 and stop issuing
 * signed URLs. The cap covers buyer downloads only — admin uploads are not
 * charged against the same bucket (R2 ingress is free anyway).
 */

const CAP_BYTES = 250 * 1024 * 1024 * 1024; // 250 GiB
const TTL_DAYS = 75; // a month + a buffer so we don't lose history mid-rollover
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

export function monthKey(shopId: number, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `bw:${shopId}:${y}-${m}`;
}

export async function getMonthlyUsage(
  kv: KVNamespace,
  shopId: number,
  now?: Date,
): Promise<number> {
  const raw = await kv.get(monthKey(shopId, now));
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function getCapBytes(): number {
  return CAP_BYTES;
}

/**
 * True when the bucket is below the cap. Run this BEFORE issuing the signed
 * URL. Returns the current usage too so the caller can include it in error
 * payloads if it decides to 429.
 */
export async function assertWithinBudget(
  kv: KVNamespace,
  shopId: number,
  now?: Date,
): Promise<{ withinBudget: boolean; usedBytes: number; capBytes: number }> {
  const usedBytes = await getMonthlyUsage(kv, shopId, now);
  return {
    withinBudget: usedBytes < CAP_BYTES,
    usedBytes,
    capBytes: CAP_BYTES,
  };
}

/**
 * Record a download. Best-effort under concurrency — KV has no atomic
 * increment, so two concurrent writes can drop one increment.
 */
export async function recordDownload(
  kv: KVNamespace,
  shopId: number,
  bytes: number,
  now?: Date,
): Promise<void> {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const key = monthKey(shopId, now);
  const current = await getMonthlyUsage(kv, shopId, now);
  const next = current + Math.ceil(bytes);
  await kv.put(key, String(next), { expirationTtl: TTL_SECONDS });
}
