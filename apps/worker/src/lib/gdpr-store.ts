/**
 * Persistence layer for the `gdpr_requests` table.
 *
 * The webhook receive layer inserts a row with a future `due_at`; the daily
 * cron sweep (`handlers/gdpr-sweep.ts`) selects due rows, flips them to
 * `processing`, runs the purge or export, and writes the terminal status.
 * The admin UI cancels or expedites pending rows during the stand-down.
 *
 * Stand-down constants live here so a future ops-console knob can override
 * them per-shop without schema changes.
 */

export const CUSTOMER_REDACT_GRACE_S = 7 * 86400;
export const SHOP_REDACT_GRACE_S = 7 * 86400;
// Exports are not destructive; one cron tick of latency is the safety floor.
export const DATA_REQUEST_GRACE_S = 3600;
// Shopify's mandatory minimum after uninstall before purging shop data.
export const APP_UNINSTALL_PURGE_GRACE_S = 30 * 86400;

export const GDPR_KINDS = [
  'customer_data_request',
  'customer_redact',
  'shop_redact',
  'app_uninstall_purge',
] as const;
export type GdprKind = (typeof GDPR_KINDS)[number];

export const GDPR_STATUSES = [
  'pending',
  'processing',
  'completed',
  'cancelled',
  'failed',
] as const;
export type GdprStatus = (typeof GDPR_STATUSES)[number];

export interface GdprRequestRow {
  id: string;
  shop_id: number | null;
  shop_domain: string;
  kind: GdprKind;
  shopify_customer_id: string | null;
  payload_json: string;
  received_at: number;
  due_at: number;
  status: GdprStatus;
  completed_at: number | null;
  last_error: string | null;
}

export interface InsertGdprRequestInput {
  id: string;
  shop_id: number | null;
  shop_domain: string;
  kind: GdprKind;
  shopify_customer_id: string | null;
  payload_json: string;
  received_at: number;
  due_at: number;
}

function rowToRequest(row: Record<string, unknown>): GdprRequestRow {
  return {
    id: row.id as string,
    shop_id: (row.shop_id as number | null) ?? null,
    shop_domain: row.shop_domain as string,
    kind: row.kind as GdprKind,
    shopify_customer_id: (row.shopify_customer_id as string | null) ?? null,
    payload_json: row.payload_json as string,
    received_at: row.received_at as number,
    due_at: row.due_at as number,
    status: row.status as GdprStatus,
    completed_at: (row.completed_at as number | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
  };
}

export function dueAtFor(kind: GdprKind, receivedAt: number): number {
  switch (kind) {
    case 'customer_data_request':
      return receivedAt + DATA_REQUEST_GRACE_S;
    case 'customer_redact':
      return receivedAt + CUSTOMER_REDACT_GRACE_S;
    case 'shop_redact':
      return receivedAt + SHOP_REDACT_GRACE_S;
    case 'app_uninstall_purge':
      return receivedAt + APP_UNINSTALL_PURGE_GRACE_S;
  }
}

export async function insertGdprRequest(
  db: D1Database,
  input: InsertGdprRequestInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO gdpr_requests
         (id, shop_id, shop_domain, kind, shopify_customer_id,
          payload_json, received_at, due_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .bind(
      input.id,
      input.shop_id,
      input.shop_domain,
      input.kind,
      input.shopify_customer_id,
      input.payload_json,
      input.received_at,
      input.due_at,
    )
    .run();
}

export async function getGdprRequest(
  db: D1Database,
  id: string,
): Promise<GdprRequestRow | null> {
  const row = await db
    .prepare(`SELECT * FROM gdpr_requests WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? rowToRequest(row) : null;
}

export async function listPendingForShop(
  db: D1Database,
  shopId: number,
): Promise<GdprRequestRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM gdpr_requests
       WHERE shop_id = ? AND status = 'pending'
       ORDER BY due_at ASC`,
    )
    .bind(shopId)
    .all<Record<string, unknown>>();
  return (res.results ?? []).map(rowToRequest);
}

export async function listDue(
  db: D1Database,
  now: number,
  limit = 100,
): Promise<GdprRequestRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM gdpr_requests
       WHERE status = 'pending' AND due_at <= ?
       ORDER BY due_at ASC
       LIMIT ?`,
    )
    .bind(now, limit)
    .all<Record<string, unknown>>();
  return (res.results ?? []).map(rowToRequest);
}

/**
 * Atomic claim: flips pending → processing only if still pending. Returns
 * true if this caller won the race; false if a concurrent sweep already
 * grabbed it.
 */
export async function claimForProcessing(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE gdpr_requests SET status = 'processing'
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function markCompleted(
  db: D1Database,
  id: string,
  completedAt: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE gdpr_requests
         SET status = 'completed', completed_at = ?, last_error = NULL
       WHERE id = ?`,
    )
    .bind(completedAt, id)
    .run();
}

export async function markFailed(
  db: D1Database,
  id: string,
  error: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE gdpr_requests
         SET status = 'failed', last_error = ?
       WHERE id = ?`,
    )
    .bind(error.slice(0, 500), id)
    .run();
}

/**
 * Cancel a pending request. Only succeeds while the row is still pending
 * AND the stand-down window has not elapsed (`due_at > now`).
 */
export async function cancelIfPending(
  db: D1Database,
  shopId: number,
  id: string,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE gdpr_requests SET status = 'cancelled'
       WHERE id = ? AND shop_id = ? AND status = 'pending' AND due_at > ?`,
    )
    .bind(id, shopId, now)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Expedite a pending request: pull due_at forward so the next sweep tick
 * picks it up. Only valid while pending.
 */
export async function expediteIfPending(
  db: D1Database,
  shopId: number,
  id: string,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE gdpr_requests SET due_at = ?
       WHERE id = ? AND shop_id = ? AND status = 'pending'`,
    )
    .bind(now, id, shopId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
