/**
 * Admin routes for the GDPR request queue.
 *
 *   GET    /admin/gdpr/pending          → list rows still in the stand-down
 *   POST   /admin/gdpr/:id/cancel       → cancel during the stand-down only
 *   POST   /admin/gdpr/:id/process      → expedite: pull due_at to now
 *
 * Cancel and expedite are scoped to the caller's `shop_id` so a compromised
 * session for shop A can never act on shop B's queue.
 */

import { Hono } from 'hono';
import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import {
  cancelIfPending,
  expediteIfPending,
  listPendingForShop,
} from '../lib/gdpr-store.js';

export const adminGdprRouter = new Hono<{ Bindings: Env }>();

async function resolveShopId(env: Env, shopDomain: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ id: number }>();
  return row?.id ?? null;
}

adminGdprRouter.get('/gdpr/pending', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const rows = await listPendingForShop(c.env.DB, shopId);
  return c.json({
    requests: rows.map(r => ({
      id: r.id,
      kind: r.kind,
      shopify_customer_id: r.shopify_customer_id,
      received_at: r.received_at,
      due_at: r.due_at,
      status: r.status,
    })),
  });
});

adminGdprRouter.post('/gdpr/:id/cancel', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = c.req.param('id');
  const now = Math.floor(Date.now() / 1000);
  const ok = await cancelIfPending(c.env.DB, shopId, id, now);
  if (!ok) {
    return c.json(
      { error: 'request is not pending or stand-down has elapsed' },
      409,
    );
  }
  log('info', 'admin: gdpr request cancelled', {
    shop: shopDomain,
    gdpr_request_id: id,
  });
  return c.json({ ok: true });
});

adminGdprRouter.post('/gdpr/:id/process', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = c.req.param('id');
  const now = Math.floor(Date.now() / 1000);
  const ok = await expediteIfPending(c.env.DB, shopId, id, now);
  if (!ok) {
    return c.json({ error: 'request is not pending' }, 409);
  }
  log('info', 'admin: gdpr request expedited', {
    shop: shopDomain,
    gdpr_request_id: id,
  });
  return c.json({ ok: true });
});
