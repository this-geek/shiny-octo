/**
 * Daily activation-nudge sweep (Phase 1J §7).
 *
 * Runs from a Cron Trigger once a day. For each installed shop, scan
 * approved applications whose `decided_at` is within the nudge window
 * (last 70 days, padded past the 60d milestone). For each candidate:
 *   - Determine which nudge milestone (14/30/60) the buyer just hit.
 *   - Skip if that milestone's nudge has already been sent.
 *   - Skip if the buyer has placed any order since approval.
 *   - Enqueue a templated email via the existing application-email queue.
 *   - Record the nudge in application_nudges.
 *
 * The "has any order since approval" probe makes one Admin GraphQL call per
 * candidate. At pilot scale (~20 buyers per shop) that's negligible. For App
 * Store scale we'll either cache the answer in KV with a 24h TTL, or — better —
 * derive activity from `orders/create` webhooks and skip the probe entirely.
 */

import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import { decrypt } from '../lib/crypto.js';
import { hasOrderSince } from '../lib/shopify-orders.js';
import {
  hasNudgeBeenSent,
  nudgeKindForDaysSinceApproval,
  recordNudgeSent,
  daysBetween,
} from '../lib/nudge-store.js';
import { enqueueApplicationEmail } from '../lib/internal-jobs.js';

interface ShopRow {
  id: number;
  shopify_domain: string;
  access_token_encrypted: string;
}

interface CandidateRow {
  id: number;
  decided_at: number;
  shopify_customer_id: string | null;
}

/**
 * Window we even bother looking at: from ~14 days ago down to 70 days ago.
 * Padded so the 60-day milestone is still in range even if the cron skipped
 * a day. Anything older is past all nudge milestones.
 */
const LOOK_BACK_DAYS = 70;
const LOOK_FORWARD_DAYS = 14;

export async function runActivationNudgesScan(
  env: Env,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ scanned: number; sent: number }> {
  const lookBackTs = now - LOOK_BACK_DAYS * 86400;
  const lookForwardTs = now - LOOK_FORWARD_DAYS * 86400;

  const shops = await env.DB.prepare(
    `SELECT id, shopify_domain, access_token_encrypted FROM shops
     WHERE uninstalled_at IS NULL`,
  )
    .all<ShopRow>();

  let scanned = 0;
  let sent = 0;

  for (const shop of shops.results ?? []) {
    const candidates = await env.DB.prepare(
      `SELECT id, decided_at, shopify_customer_id
       FROM applications
       WHERE shop_id = ?
         AND status = 'approved'
         AND decided_at IS NOT NULL
         AND decided_at >= ?
         AND decided_at <= ?`,
    )
      .bind(shop.id, lookBackTs, lookForwardTs)
      .all<CandidateRow>();

    let token: string | null = null;
    for (const app of candidates.results ?? []) {
      scanned++;
      try {
        const kind = nudgeKindForDaysSinceApproval(daysBetween(app.decided_at, now));
        if (!kind) continue;
        if (await hasNudgeBeenSent(env.DB, app.id, kind)) continue;

        if (app.shopify_customer_id) {
          if (!token) {
            try {
              token = await decrypt(
                shop.access_token_encrypted,
                shop.shopify_domain,
                env.MASTER_KEY,
              );
            } catch (err) {
              log('warn', 'activation-nudges: shop token decrypt failed, skipping shop', {
                shop: shop.shopify_domain,
                error: String(err),
              });
              break;
            }
          }
          const active = await hasOrderSince(
            shop.shopify_domain,
            token,
            env.SHOPIFY_API_VERSION,
            app.shopify_customer_id,
            app.decided_at,
          ).catch(err => {
            log('warn', 'activation-nudges: order probe failed, sending nudge anyway', {
              shop: shop.shopify_domain,
              application_id: app.id,
              error: String(err),
            });
            return false;
          });
          if (active) {
            // Buyer already ordered — don't pester them, and don't burn the
            // milestone either; let the next milestone re-evaluate.
            continue;
          }
        }

        await enqueueApplicationEmail(env, shop.shopify_domain, app.id, kind);
        await recordNudgeSent(env.DB, app.id, kind, now);
        sent++;
        log('info', 'activation-nudges: enqueued', {
          shop: shop.shopify_domain,
          application_id: app.id,
          kind,
        });
      } catch (err) {
        log('error', 'activation-nudges: candidate failed', {
          shop: shop.shopify_domain,
          application_id: app.id,
          error: String(err),
        });
      }
    }
  }

  log('info', 'activation-nudges: scan complete', { scanned, sent });
  return { scanned, sent };
}
