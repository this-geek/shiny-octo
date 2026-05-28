/**
 * Daily sweep: process due `gdpr_requests` rows.
 *
 * Run from the same cron tick as `runActivationNudgesScan`. The sweep:
 *   1. Selects all pending rows whose `due_at <= now`.
 *   2. Atomically claims each row (pending → processing).
 *   3. Dispatches by `kind` to the appropriate export/purge function.
 *   4. Records the terminal status (`completed` or `failed`).
 *
 * Stand-down semantics live in `lib/gdpr-store.ts` — the sweep itself is
 * unaware of the 7-day window; it just respects `due_at`. That keeps the
 * grace logic in one place and makes the admin UI's "Process Now" button
 * a single `expediteIfPending` call (set `due_at = now`).
 */

import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import {
  claimForProcessing,
  listDue,
  markCompleted,
  markFailed,
  type GdprRequestRow,
} from '../lib/gdpr-store.js';
import { redactCustomer, redactShop } from '../lib/gdpr-purge.js';
import { enqueueGdprDataExport } from '../lib/internal-jobs.js';

const SWEEP_BATCH_LIMIT = 100;

export interface SweepResult {
  processed: number;
  failed: number;
  skipped: number;
}

export async function runGdprSweep(
  env: Env,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SweepResult> {
  const due = await listDue(env.DB, now, SWEEP_BATCH_LIMIT);
  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of due) {
    const won = await claimForProcessing(env.DB, row.id);
    if (!won) {
      // Another worker grabbed it first; that's fine, move on.
      skipped++;
      continue;
    }

    try {
      await processOne(env, row);
      await markCompleted(env.DB, row.id, Math.floor(Date.now() / 1000));
      processed++;
      log('info', 'gdpr-sweep: processed', {
        shop: row.shop_domain,
        gdpr_request_id: row.id,
        kind: row.kind,
      });
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      await markFailed(env.DB, row.id, message);
      log('error', 'gdpr-sweep: failed', {
        shop: row.shop_domain,
        gdpr_request_id: row.id,
        kind: row.kind,
        error: message,
      });
    }
  }

  log('info', 'gdpr-sweep: scan complete', { processed, failed, skipped });
  return { processed, failed, skipped };
}

async function processOne(env: Env, row: GdprRequestRow): Promise<void> {
  switch (row.kind) {
    case 'customer_data_request':
      // Hand off to the email queue so retries are isolated from the sweep.
      // The sweep marks the row completed once enqueue succeeds; delivery
      // failures surface via the queue's own dead-lettering, not here.
      if (!row.shopify_customer_id) {
        throw new Error('customer_data_request missing customer id');
      }
      await enqueueGdprDataExport(env, row.shop_domain, row.id);
      return;

    case 'customer_redact':
      if (row.shop_id === null) {
        // Shop already gone — nothing buyer-specific left to purge.
        log('warn', 'gdpr-sweep: customer_redact for purged shop', {
          shop: row.shop_domain,
          gdpr_request_id: row.id,
        });
        return;
      }
      if (!row.shopify_customer_id) {
        throw new Error('customer_redact missing customer id');
      }
      await redactCustomer(env, row.shop_id, row.shopify_customer_id);
      return;

    case 'shop_redact':
    case 'app_uninstall_purge':
      if (row.shop_id === null) {
        log('info', 'gdpr-sweep: shop already purged', {
          shop: row.shop_domain,
          gdpr_request_id: row.id,
          kind: row.kind,
        });
        return;
      }
      await redactShop(env, row.shop_id);
      return;
  }
}
