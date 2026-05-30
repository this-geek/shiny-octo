/**
 * Merchant-scope audit log.
 *
 * Every privileged write that a Shopify staff user performs against this
 * app should produce one `audit_log` row. The actor is the session-token
 * `sub` (a Shopify staff user GID); the entity is whichever D1/Shopify
 * object the action mutated. Reader lives behind the same admin-session
 * auth as the rest of `/admin/*`.
 *
 * Failures throw — audit writes are part of the action, not a side
 * effect. Callers that want best-effort behaviour can wrap in try/catch
 * explicitly.
 */

export type AuditEntityType =
  | 'application'
  | 'tier'
  | 'company_mapping'
  | 'asset';

export interface AuditWrite {
  shopId: number;
  actor: string;
  action: string;
  entityType: AuditEntityType;
  entityId: string | number;
  details?: Record<string, unknown> | null;
}

export interface AuditRow {
  id: number;
  shop_id: number;
  actor: string;
  action: string;
  entity_type: AuditEntityType;
  entity_id: string;
  details_json: string | null;
  occurred_at: number;
}

export interface AuditListOptions {
  entityType?: AuditEntityType;
  entityId?: string | number;
  actor?: string;
  limit?: number;
  before?: number;
}

export async function writeAudit(db: D1Database, w: AuditWrite): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const detailsJson =
    w.details === undefined || w.details === null
      ? null
      : JSON.stringify(w.details);
  await db
    .prepare(
      `INSERT INTO audit_log
         (shop_id, actor, action, entity_type, entity_id, details_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      w.shopId,
      w.actor,
      w.action,
      w.entityType,
      String(w.entityId),
      detailsJson,
      now,
    )
    .run();
}

export async function listAudit(
  db: D1Database,
  shopId: number,
  opts: AuditListOptions = {},
): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const clauses: string[] = ['shop_id = ?'];
  const binds: unknown[] = [shopId];

  if (opts.entityType) {
    clauses.push('entity_type = ?');
    binds.push(opts.entityType);
  }
  if (opts.entityId !== undefined) {
    clauses.push('entity_id = ?');
    binds.push(String(opts.entityId));
  }
  if (opts.actor) {
    clauses.push('actor = ?');
    binds.push(opts.actor);
  }
  if (opts.before !== undefined) {
    clauses.push('occurred_at < ?');
    binds.push(opts.before);
  }

  const sql = `
    SELECT id, shop_id, actor, action, entity_type, entity_id,
           details_json, occurred_at
    FROM audit_log
    WHERE ${clauses.join(' AND ')}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?`;
  binds.push(limit);

  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map(r => ({
    id: r.id as number,
    shop_id: r.shop_id as number,
    actor: r.actor as string,
    action: r.action as string,
    entity_type: r.entity_type as AuditEntityType,
    entity_id: r.entity_id as string,
    details_json: (r.details_json as string | null) ?? null,
    occurred_at: r.occurred_at as number,
  }));
}
