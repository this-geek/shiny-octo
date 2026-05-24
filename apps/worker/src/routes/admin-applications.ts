/**
 * Admin approval queue routes.
 *
 *   GET    /admin/applications?status=submitted   → list
 *   GET    /admin/applications/:id                → detail (decrypted form)
 *   GET    /admin/applications/:id/document?key=  → 24h signed URL (via Worker stream)
 *   POST   /admin/applications/:id/approve        → companyCreate + record decision + email
 *   POST   /admin/applications/:id/reject         → record decision + email
 *   POST   /admin/applications/:id/request-info   → record decision + email
 *
 * Approve is idempotent: a second click with the same payload returns the
 * existing Company / Location ids without creating duplicates (the underlying
 * Shopify mutation also uses X-Idempotency-Key).
 */

import { Hono } from 'hono';
import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import {
  APPLICATION_STATUSES,
  ApplicationStateError,
  getApplicationDetail,
  getApplicationRow,
  listApplications,
  recordDecision,
  type ApplicationStatus,
} from '../lib/application-store.js';
import { getShopAuth } from '../lib/shop-token.js';
import {
  CompanyCreateError,
  createCompanyForApplication,
} from '../lib/shopify-companies-create.js';
import { enqueueApplicationEmail } from '../lib/internal-jobs.js';
import { assertKeyBelongsToShop } from '../lib/r2-keys.js';

export const adminApplicationsRouter = new Hono<{ Bindings: Env }>();

async function resolveShopId(env: Env, shopDomain: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ id: number }>();
  return row?.id ?? null;
}

adminApplicationsRouter.get('/applications', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const statusParam = c.req.query('status');
  let status: ApplicationStatus | undefined;
  if (statusParam) {
    if (!(APPLICATION_STATUSES as readonly string[]).includes(statusParam)) {
      return c.json({ error: 'invalid status' }, 400);
    }
    status = statusParam as ApplicationStatus;
  }

  const apps = await listApplications(c.env.DB, shopId, { status });
  return c.json({ applications: apps });
});

adminApplicationsRouter.get('/applications/:id', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  const detail = await getApplicationDetail(
    c.env.DB,
    shopId,
    id,
    shopDomain,
    c.env.MASTER_KEY,
  );
  if (!detail) return c.json({ error: 'not found' }, 404);
  return c.json({ application: detail });
});

/**
 * Stream an application document through the Worker. We don't hand out R2
 * presigned URLs — that would leak the bucket layout and bypass the per-shop
 * auth fence. Same pattern as buyer asset downloads in Phase 1C.
 */
adminApplicationsRouter.get('/applications/:id/document', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  const key = c.req.query('key');
  if (!key) return c.json({ error: 'missing key' }, 400);

  const detail = await getApplicationDetail(
    c.env.DB,
    shopId,
    id,
    shopDomain,
    c.env.MASTER_KEY,
  );
  if (!detail) return c.json({ error: 'not found' }, 404);

  // The requested key must (a) belong to this shop and (b) be in the
  // application's document list — preventing an admin from any shop reading
  // arbitrary R2 objects with this endpoint.
  try {
    assertKeyBelongsToShop(key, shopId);
  } catch {
    return c.json({ error: 'forbidden' }, 403);
  }
  const allowed = detail.form.documents.some(d => d.r2_key === key);
  if (!allowed) return c.json({ error: 'forbidden' }, 403);

  const obj = await c.env.ASSETS_BUCKET.get(key);
  if (!obj) return c.json({ error: 'object not found' }, 404);

  const headers = new Headers();
  const doc = detail.form.documents.find(d => d.r2_key === key);
  if (doc?.mime) headers.set('Content-Type', doc.mime);
  headers.set(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(doc?.name ?? 'document')}"`,
  );
  if (doc?.size) headers.set('Content-Length', String(doc.size));
  headers.set('Cache-Control', 'private, no-store');
  return new Response(obj.body, { status: 200, headers });
});

interface DecisionBody {
  notes?: unknown;
}

adminApplicationsRouter.post('/applications/:id/approve', async c => {
  const shopDomain = c.get('shopDomain');
  const sessionPayload = c.get('sessionPayload');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  let body: DecisionBody = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as DecisionBody;
  } catch {
    body = {};
  }

  const detail = await getApplicationDetail(
    c.env.DB,
    shopId,
    id,
    shopDomain,
    c.env.MASTER_KEY,
  );
  if (!detail) return c.json({ error: 'not found' }, 404);

  // Idempotent re-approval: if we already have a Company on file, skip the
  // Shopify call entirely and just refresh the audit row.
  if (detail.status === 'approved' && detail.created_company_id) {
    const { row } = await recordDecision(c.env.DB, shopId, id, {
      status: 'approved',
      decidedBy: sessionPayload.sub,
      notes: typeof body.notes === 'string' ? body.notes : detail.decision_notes,
    });
    return c.json({
      application: row,
      created_company_id: row.created_company_id,
      created_location_id: row.created_location_id,
      idempotent: true,
    });
  }

  if (detail.status === 'rejected') {
    return c.json({ error: 'application is rejected; cannot approve' }, 409);
  }

  // Run the Shopify mutation. X-Idempotency-Key keys off the application id
  // so double-click / queue-retry produces the same Company.
  const auth = await getShopAuth(c.env, shopDomain);
  if (!auth) return c.json({ error: 'shop auth unavailable' }, 502);

  let result;
  try {
    result = await createCompanyForApplication(
      shopDomain,
      auth.token,
      c.env.SHOPIFY_API_VERSION,
      {
        email: detail.email,
        companyName: detail.form.companyName ?? detail.email,
        externalApplicationId: detail.id,
      },
    );
  } catch (err) {
    if (err instanceof CompanyCreateError) {
      log('error', 'admin: companyCreate failed', {
        shop: shopDomain,
        application_id: id,
        error: err.message,
        userErrors: err.userErrors,
      });
      return c.json({ error: err.message, userErrors: err.userErrors }, 502);
    }
    throw err;
  }

  const { row } = await recordDecision(c.env.DB, shopId, id, {
    status: 'approved',
    decidedBy: sessionPayload.sub,
    notes: typeof body.notes === 'string' ? body.notes : null,
    companyId: result.companyId,
    locationId: result.locationId,
    customerId: result.customerId,
  });

  await enqueueApplicationEmail(c.env, shopDomain, id, 'approved');

  log('info', 'admin: application approved', {
    shop: shopDomain,
    application_id: id,
    company: result.companyId,
  });

  return c.json({
    application: row,
    created_company_id: result.companyId,
    created_location_id: result.locationId,
    idempotent: false,
  });
});

adminApplicationsRouter.post('/applications/:id/reject', async c => {
  return handleSimpleDecision(c, 'rejected');
});

adminApplicationsRouter.post('/applications/:id/request-info', async c => {
  return handleSimpleDecision(c, 'needs_info');
});

async function handleSimpleDecision(
  c: import('hono').Context<{ Bindings: Env }>,
  status: 'rejected' | 'needs_info',
): Promise<Response> {
  const shopDomain = c.get('shopDomain');
  const sessionPayload = c.get('sessionPayload');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id') ?? '', 10);
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  let body: DecisionBody = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as DecisionBody;
  } catch {
    body = {};
  }

  const row = await getApplicationRow(c.env.DB, shopId, id);
  if (!row) return c.json({ error: 'not found' }, 404);

  try {
    const { row: updated, alreadyApplied } = await recordDecision(c.env.DB, shopId, id, {
      status,
      decidedBy: sessionPayload.sub,
      notes: typeof body.notes === 'string' ? body.notes : null,
    });
    if (!alreadyApplied) {
      await enqueueApplicationEmail(
        c.env,
        shopDomain,
        id,
        status === 'rejected' ? 'rejected' : 'needs_info',
      );
    }
    log('info', `admin: application ${status}`, {
      shop: shopDomain,
      application_id: id,
      idempotent: alreadyApplied,
    });
    return c.json({ application: updated, idempotent: alreadyApplied });
  } catch (err) {
    if (err instanceof ApplicationStateError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
}
