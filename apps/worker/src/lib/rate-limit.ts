/**
 * KV-backed fixed-window rate limiter (Phase 2 hardening).
 *
 *   rl:<bucket>:<id>:<minute_epoch>  →  count this minute (decimal string)
 *
 * Fixed-window keyed on the UTC minute. The window resets on the minute
 * boundary, so a caller can briefly exceed the configured rate at the
 * boundary (worst case ≈ 2× limit across 2s); that's acceptable for the
 * defensive use case here — we're keeping bad actors from melting the
 * Worker, not enforcing a billable quota.
 *
 * Workers KV lacks atomic increment, so two concurrent puts in the same
 * window can drop one increment. Again — defensive, not exact.
 *
 * `Retry-After` is the number of seconds remaining in the current
 * window, rounded up to 1.
 */

const TTL_SECONDS = 90; // window is 60s; +30s buffer so reads near the boundary still see the count

export interface RateLimitResult {
  allowed: boolean;
  /** Current count INCLUDING this request (after the increment). */
  count: number;
  /** Configured per-minute ceiling. */
  limit: number;
  /** Seconds until the current window resets; >= 1 when denied. */
  retryAfterSeconds: number;
}

export function windowKey(bucket: string, id: string, now: Date = new Date()): string {
  const minute = Math.floor(now.getTime() / 60_000);
  return `rl:${bucket}:${id}:${minute}`;
}

function secondsUntilNextWindow(now: Date): number {
  const ms = 60_000 - (now.getTime() % 60_000);
  return Math.max(1, Math.ceil(ms / 1000));
}

export async function checkRateLimit(
  kv: KVNamespace,
  bucket: string,
  id: string,
  limit: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  if (limit <= 0) {
    return { allowed: false, count: 0, limit, retryAfterSeconds: secondsUntilNextWindow(now) };
  }
  const key = windowKey(bucket, id, now);
  const raw = await kv.get(key);
  const current = raw === null ? 0 : Math.max(0, Number.parseInt(raw, 10) || 0);

  if (current >= limit) {
    return {
      allowed: false,
      count: current,
      limit,
      retryAfterSeconds: secondsUntilNextWindow(now),
    };
  }

  const next = current + 1;
  await kv.put(key, String(next), { expirationTtl: TTL_SECONDS });
  return { allowed: true, count: next, limit, retryAfterSeconds: 0 };
}
