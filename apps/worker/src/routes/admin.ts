import { Hono } from 'hono';
import type { Env } from '../types.js';
import { sessionTokenMiddleware } from '../middleware/session-token.js';
import { log } from '../lib/logger.js';

export const adminRouter = new Hono<{ Bindings: Env }>();

adminRouter.use('*', sessionTokenMiddleware);

adminRouter.get('/shop-status', async c => {
  const shopDomain = c.get('shopDomain');
  const row = await c.env.DB.prepare(
    `SELECT is_plus, plus_banner_dismissed_at FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ is_plus: number; plus_banner_dismissed_at: number | null }>();

  if (!row) {
    return c.json(
      { is_plus: false, plus_banner_dismissed: false, shop_domain: shopDomain },
      200,
    );
  }

  return c.json({
    is_plus: row.is_plus === 1,
    plus_banner_dismissed: row.plus_banner_dismissed_at !== null,
    shop_domain: shopDomain,
  });
});

adminRouter.post('/plus-banner/dismiss', async c => {
  const shopDomain = c.get('shopDomain');
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(
    `UPDATE shops SET plus_banner_dismissed_at = ?
     WHERE shopify_domain = ? AND plus_banner_dismissed_at IS NULL`,
  )
    .bind(now, shopDomain)
    .run();

  log('info', 'admin: plus banner dismissed', { shop: shopDomain });

  return c.json({ ok: true });
});
