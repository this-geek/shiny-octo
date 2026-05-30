/**
 * `/_ops/*` — internal operator console (DECISIONS #17).
 *
 * Gated by `opsAccessMiddleware` (CF Access JWT). Every mutation writes
 * one `ops_log` row with the verified operator email; reads are not
 * logged (the volume of GET-only inspection would drown actionable
 * events). All routes are cross-tenant by design — the per-shop
 * isolation that protects merchants from each other does not apply to
 * the app vendor's own ops staff.
 *
 * v1 scope (kept minimal because the pilot only needs the basics):
 *   - shops listing + detail with counts
 *   - per-shop feature flags (read/write into shops.settings_json)
 *   - cross-tenant audit_log + ops_log views
 *   - GDPR queue inspection + cancel / expedite
 *   - webhook_log listing (replay is out of scope; bodies aren't stored)
 *
 * Out of scope for v1:
 *   - Webhook replay — webhook_log doesn't capture bodies and Shopify
 *     doesn't expose a re-delivery API, so a true replay would need a
 *     body sidecar. Tracked in PLAN as a follow-up.
 *   - Encryption-key rotation — requires re-encrypting every D1 row
 *     scoped to the old key; the read surface here just shows the
 *     master-key fingerprint so operators can confirm a rotation
 *     landed end-to-end.
 */

import { Hono } from 'hono';
import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import { opsAccessMiddleware } from '../middleware/ops-access.js';
import {
  listAudit,
  type AuditEntityType,
} from '../lib/audit-log.js';
import { listOpsLog, writeOpsLog } from '../lib/ops-log.js';
import {
  cancelIfPending,
  expediteIfPending,
  getGdprRequest,
  listDue,
  listPendingForShop,
} from '../lib/gdpr-store.js';
import {
  parseSettingsBlob,
  type SettingsBlob,
} from '../lib/settings.js';

export const opsRouter = new Hono<{ Bindings: Env }>();

opsRouter.use('*', opsAccessMiddleware);

// ---------------------------------------------------------------------------
// Identity probe
// ---------------------------------------------------------------------------

opsRouter.get('/whoami', c => {
  return c.json({ email: c.get('operatorEmail') });
});

// ---------------------------------------------------------------------------
// Shops
// ---------------------------------------------------------------------------

interface ShopRow {
  id: number;
  shopify_domain: string;
  shopify_shop_id: number;
  is_plus: number;
  plan_id: string;
  installed_at: number;
  uninstalled_at: number | null;
}

opsRouter.get('/shops', async c => {
  const limit = Math.min(
    Math.max(Number.parseInt(c.req.query('limit') ?? '100', 10) || 100, 1),
    500,
  );
  const result = await c.env.DB.prepare(
    `SELECT id, shopify_domain, shopify_shop_id, is_plus, plan_id,
            installed_at, uninstalled_at
     FROM shops
     ORDER BY installed_at DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<ShopRow>();
  return c.json({
    shops: (result.results ?? []).map(r => ({
      id: r.id,
      shopify_domain: r.shopify_domain,
      shopify_shop_id: r.shopify_shop_id,
      is_plus: r.is_plus === 1,
      plan_id: r.plan_id,
      installed_at: r.installed_at,
      uninstalled_at: r.uninstalled_at,
    })),
  });
});

async function resolveShop(env: Env, domain: string): Promise<ShopRow | null> {
  return env.DB.prepare(
    `SELECT id, shopify_domain, shopify_shop_id, is_plus, plan_id,
            installed_at, uninstalled_at
     FROM shops WHERE shopify_domain = ?`,
  )
    .bind(domain)
    .first<ShopRow>();
}

opsRouter.get('/shops/:domain', async c => {
  const domain = decodeURIComponent(c.req.param('domain'));
  const shop = await resolveShop(c.env, domain);
  if (!shop) return c.json({ error: 'shop not found' }, 404);

  const counts = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tiers WHERE shop_id = ? AND deleted_at IS NULL) AS tiers,
       (SELECT COUNT(*) FROM company_tier_mappings WHERE shop_id = ?) AS mappings,
       (SELECT COUNT(*) FROM applications WHERE shop_id = ?) AS applications,
       (SELECT COUNT(*) FROM applications WHERE shop_id = ? AND status = 'submitted') AS pending_applications,
       (SELECT COUNT(*) FROM assets WHERE shop_id = ? AND deleted_at IS NULL) AS assets,
       (SELECT COUNT(*) FROM gdpr_requests WHERE shop_id = ? AND status = 'pending') AS pending_gdpr
    `,
  )
    .bind(shop.id, shop.id, shop.id, shop.id, shop.id, shop.id)
    .first<Record<string, number>>();

  return c.json({
    shop: {
      id: shop.id,
      shopify_domain: shop.shopify_domain,
      shopify_shop_id: shop.shopify_shop_id,
      is_plus: shop.is_plus === 1,
      plan_id: shop.plan_id,
      installed_at: shop.installed_at,
      uninstalled_at: shop.uninstalled_at,
    },
    counts: counts ?? {},
  });
});

// ---------------------------------------------------------------------------
// Per-shop feature flags
// ---------------------------------------------------------------------------

const FLAG_NAME = /^[a-z][a-z0-9_]{0,63}$/;

interface FlagsBlob {
  featureFlags?: Record<string, boolean>;
}

function readFlags(blob: SettingsBlob): Record<string, boolean> {
  const ff = (blob as FlagsBlob).featureFlags;
  if (!ff || typeof ff !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(ff)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

opsRouter.get('/shops/:domain/feature-flags', async c => {
  const domain = decodeURIComponent(c.req.param('domain'));
  const row = await c.env.DB.prepare(
    `SELECT settings_json FROM shops WHERE shopify_domain = ?`,
  )
    .bind(domain)
    .first<{ settings_json: string }>();
  if (!row) return c.json({ error: 'shop not found' }, 404);
  return c.json({ flags: readFlags(parseSettingsBlob(row.settings_json)) });
});

opsRouter.put('/shops/:domain/feature-flags', async c => {
  const domain = decodeURIComponent(c.req.param('domain'));
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const flags = (body as { flags?: unknown }).flags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
    return c.json({ error: 'flags must be an object of {name: boolean}' }, 400);
  }
  const cleaned: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(flags as Record<string, unknown>)) {
    if (!FLAG_NAME.test(k)) {
      return c.json({ error: `flag name "${k}" does not match ${FLAG_NAME}` }, 400);
    }
    if (typeof v !== 'boolean') {
      return c.json({ error: `flag "${k}" must be boolean` }, 400);
    }
    cleaned[k] = v;
  }

  const shop = await resolveShop(c.env, domain);
  if (!shop) return c.json({ error: 'shop not found' }, 404);

  const row = await c.env.DB.prepare(
    `SELECT settings_json FROM shops WHERE shopify_domain = ?`,
  )
    .bind(domain)
    .first<{ settings_json: string }>();
  const blob = parseSettingsBlob(row?.settings_json);
  const before = readFlags(blob);
  const merged: SettingsBlob = { ...blob, featureFlags: cleaned };
  await c.env.DB.prepare(`UPDATE shops SET settings_json = ? WHERE shopify_domain = ?`)
    .bind(JSON.stringify(merged), domain)
    .run();

  await writeOpsLog(c.env.DB, {
    shopId: shop.id,
    operatorEmail: c.get('operatorEmail'),
    action: 'feature_flags.update',
    details: { before, after: cleaned },
  });
  log('info', '_ops: feature flags updated', {
    shop: domain,
    operator: c.get('operatorEmail'),
  });
  return c.json({ flags: cleaned });
});

// ---------------------------------------------------------------------------
// Audit log / ops log views
// ---------------------------------------------------------------------------

const AUDIT_ENTITY_TYPES: ReadonlyArray<AuditEntityType> = [
  'application',
  'tier',
  'company_mapping',
  'asset',
];

opsRouter.get('/shops/:domain/audit-log', async c => {
  const domain = decodeURIComponent(c.req.param('domain'));
  const shop = await resolveShop(c.env, domain);
  if (!shop) return c.json({ error: 'shop not found' }, 404);

  const entityTypeParam = c.req.query('entity_type');
  let entityType: AuditEntityType | undefined;
  if (entityTypeParam) {
    if (!(AUDIT_ENTITY_TYPES as readonly string[]).includes(entityTypeParam)) {
      return c.json({ error: 'invalid entity_type' }, 400);
    }
    entityType = entityTypeParam as AuditEntityType;
  }
  const limit = Number.parseInt(c.req.query('limit') ?? '100', 10) || 100;
  const before = c.req.query('before')
    ? Number.parseInt(c.req.query('before')!, 10)
    : undefined;

  const entries = await listAudit(c.env.DB, shop.id, {
    entityType,
    entityId: c.req.query('entity_id') ?? undefined,
    actor: c.req.query('actor') ?? undefined,
    limit,
    before,
  });
  return c.json({ entries });
});

opsRouter.get('/ops-log', async c => {
  const shopDomain = c.req.query('shop');
  let shopId: number | undefined;
  if (shopDomain) {
    const shop = await resolveShop(c.env, shopDomain);
    if (!shop) return c.json({ error: 'shop not found' }, 404);
    shopId = shop.id;
  }
  const limit = Number.parseInt(c.req.query('limit') ?? '100', 10) || 100;
  const before = c.req.query('before')
    ? Number.parseInt(c.req.query('before')!, 10)
    : undefined;
  const entries = await listOpsLog(c.env.DB, {
    shopId,
    operatorEmail: c.req.query('operator') ?? undefined,
    limit,
    before,
  });
  return c.json({ entries });
});

// ---------------------------------------------------------------------------
// GDPR queue (cross-tenant)
// ---------------------------------------------------------------------------

opsRouter.get('/gdpr/pending', async c => {
  const shopDomain = c.req.query('shop');
  let rows;
  if (shopDomain) {
    const shop = await resolveShop(c.env, shopDomain);
    if (!shop) return c.json({ error: 'shop not found' }, 404);
    rows = await listPendingForShop(c.env.DB, shop.id);
  } else {
    // No per-shop filter: surface every still-pending request, even ones
    // whose stand-down has elapsed (those are due now and the next cron
    // tick will process them).
    const now = Math.floor(Date.now() / 1000);
    const due = await listDue(c.env.DB, now + 30 * 86400, 500);
    rows = due;
  }
  return c.json({
    requests: rows.map(r => ({
      id: r.id,
      shop_id: r.shop_id,
      shop_domain: r.shop_domain,
      kind: r.kind,
      shopify_customer_id: r.shopify_customer_id,
      received_at: r.received_at,
      due_at: r.due_at,
      status: r.status,
    })),
  });
});

opsRouter.post('/gdpr/:id/cancel', async c => {
  const id = c.req.param('id');
  const req = await getGdprRequest(c.env.DB, id);
  if (!req) return c.json({ error: 'request not found' }, 404);
  if (req.shop_id === null) {
    return c.json({ error: 'request has no shop_id (already purged)' }, 409);
  }
  const now = Math.floor(Date.now() / 1000);
  const ok = await cancelIfPending(c.env.DB, req.shop_id, id, now);
  if (!ok) {
    return c.json(
      { error: 'request is not pending or stand-down has elapsed' },
      409,
    );
  }
  await writeOpsLog(c.env.DB, {
    shopId: req.shop_id,
    operatorEmail: c.get('operatorEmail'),
    action: 'gdpr.cancel',
    details: { gdpr_request_id: id, kind: req.kind },
  });
  return c.json({ ok: true });
});

opsRouter.post('/gdpr/:id/process', async c => {
  const id = c.req.param('id');
  const req = await getGdprRequest(c.env.DB, id);
  if (!req) return c.json({ error: 'request not found' }, 404);
  if (req.shop_id === null) {
    return c.json({ error: 'request has no shop_id (already purged)' }, 409);
  }
  const now = Math.floor(Date.now() / 1000);
  const ok = await expediteIfPending(c.env.DB, req.shop_id, id, now);
  if (!ok) {
    return c.json({ error: 'request is not pending' }, 409);
  }
  await writeOpsLog(c.env.DB, {
    shopId: req.shop_id,
    operatorEmail: c.get('operatorEmail'),
    action: 'gdpr.expedite',
    details: { gdpr_request_id: id, kind: req.kind },
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Webhook log (read-only; replay needs body sidecar — tracked in PLAN)
// ---------------------------------------------------------------------------

interface WebhookLogRow {
  id: string;
  shop_id: number;
  topic: string;
  received_at: number;
  processed_at: number | null;
  status: 'pending' | 'processed' | 'failed';
}

opsRouter.get('/webhooks', async c => {
  const shopDomain = c.req.query('shop');
  const status = c.req.query('status');
  const limit = Math.min(
    Math.max(Number.parseInt(c.req.query('limit') ?? '100', 10) || 100, 1),
    500,
  );

  let shopId: number | undefined;
  if (shopDomain) {
    const shop = await resolveShop(c.env, shopDomain);
    if (!shop) return c.json({ error: 'shop not found' }, 404);
    shopId = shop.id;
  }
  if (status && !['pending', 'processed', 'failed'].includes(status)) {
    return c.json({ error: 'invalid status' }, 400);
  }

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (shopId !== undefined) {
    clauses.push('shop_id = ?');
    binds.push(shopId);
  }
  if (status) {
    clauses.push('status = ?');
    binds.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  binds.push(limit);

  const result = await c.env.DB.prepare(
    `SELECT id, shop_id, topic, received_at, processed_at, status
     FROM webhook_log
     ${where}
     ORDER BY received_at DESC
     LIMIT ?`,
  )
    .bind(...binds)
    .all<WebhookLogRow>();

  return c.json({ entries: result.results ?? [] });
});
