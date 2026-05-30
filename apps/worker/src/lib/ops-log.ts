/**
 * Operator audit log (`ops_log` table from migration 0001).
 *
 * Mirrors `audit-log.ts` but scoped to cross-tenant operator actions
 * performed via the `/_ops/*` console. The actor is a CF Access SSO
 * email (already verified by the middleware), so we don't bother
 * normalising it further.
 */

export interface OpsLogWrite {
  /** NULL for cross-tenant / global actions (e.g. listing all shops). */
  shopId: number | null;
  operatorEmail: string;
  action: string;
  details?: Record<string, unknown> | null;
}

export interface OpsLogRow {
  id: number;
  shop_id: number | null;
  operator_email: string;
  action: string;
  details_json: string | null;
  occurred_at: number;
}

export interface OpsLogListOptions {
  shopId?: number;
  operatorEmail?: string;
  limit?: number;
  before?: number;
}

export async function writeOpsLog(db: D1Database, w: OpsLogWrite): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const detailsJson =
    w.details === undefined || w.details === null ? null : JSON.stringify(w.details);
  await db
    .prepare(
      `INSERT INTO ops_log (shop_id, operator_email, action, details_json, occurred_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(w.shopId, w.operatorEmail, w.action, detailsJson, now)
    .run();
}

export async function listOpsLog(
  db: D1Database,
  opts: OpsLogListOptions = {},
): Promise<OpsLogRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (opts.shopId !== undefined) {
    clauses.push('shop_id = ?');
    binds.push(opts.shopId);
  }
  if (opts.operatorEmail) {
    clauses.push('operator_email = ?');
    binds.push(opts.operatorEmail);
  }
  if (opts.before !== undefined) {
    clauses.push('occurred_at < ?');
    binds.push(opts.before);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `
    SELECT id, shop_id, operator_email, action, details_json, occurred_at
    FROM ops_log
    ${where}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?`;
  binds.push(limit);

  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map(r => ({
    id: r.id as number,
    shop_id: (r.shop_id as number | null) ?? null,
    operator_email: r.operator_email as string,
    action: r.action as string,
    details_json: (r.details_json as string | null) ?? null,
    occurred_at: r.occurred_at as number,
  }));
}
