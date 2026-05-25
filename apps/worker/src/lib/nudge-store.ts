/**
 * Ledger of activation-nudge emails already sent for an application.
 *
 * One row per (application_id, kind). The daily cron consults this before
 * enqueueing a nudge so a retry / clock drift / replayed run can't fire the
 * same email twice.
 */

import type { NudgeKind } from './internal-jobs.js';

export const NUDGE_KINDS: readonly NudgeKind[] = ['nudge_14d', 'nudge_30d', 'nudge_60d'];

export const NUDGE_DAY_OFFSETS: Record<NudgeKind, number> = {
  nudge_14d: 14,
  nudge_30d: 30,
  nudge_60d: 60,
};

export async function hasNudgeBeenSent(
  db: D1Database,
  applicationId: number,
  kind: NudgeKind,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM application_nudges
       WHERE application_id = ? AND kind = ?`,
    )
    .bind(applicationId, kind)
    .first<{ x: number }>();
  return row !== null;
}

export async function recordNudgeSent(
  db: D1Database,
  applicationId: number,
  kind: NudgeKind,
  sentAt: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO application_nudges (application_id, kind, sent_at)
       VALUES (?, ?, ?)`,
    )
    .bind(applicationId, kind, sentAt)
    .run();
}

/**
 * The single nudge kind whose target day matches the supplied "days since
 * approval" value, or null when the gap doesn't line up with any tracked
 * milestone (within the slack window). The slack is a +/- 1 day allowance
 * because the cron runs once a day and `approved_at` can be at any wall-clock
 * time; without it we'd skip a milestone any time the cron ran a few minutes
 * earlier than the approval anniversary.
 */
export function nudgeKindForDaysSinceApproval(days: number): NudgeKind | null {
  for (const kind of NUDGE_KINDS) {
    const target = NUDGE_DAY_OFFSETS[kind];
    if (days >= target && days < target + 2) return kind;
  }
  return null;
}

export function daysBetween(earlier: number, later: number): number {
  if (later < earlier) return 0;
  return Math.floor((later - earlier) / 86400);
}
