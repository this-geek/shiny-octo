import { Hono } from 'hono';
import type { Env } from '../types.js';
import { sessionTokenMiddleware } from '../middleware/session-token.js';
import { adminCors } from '../middleware/cors.js';
import { log } from '../lib/logger.js';
import {
  mergeSettings,
  parseSettingsBlob,
  pickAdminSettings,
  SettingsValidationError,
  validateAdminSettingsPatch,
} from '../lib/settings.js';
import { adminTiersRouter } from './admin-tiers.js';
import { adminAssetsRouter } from './admin-assets.js';
import { adminApplicationsRouter } from './admin-applications.js';

export const adminRouter = new Hono<{ Bindings: Env }>();

adminRouter.use('*', adminCors);
adminRouter.use('*', sessionTokenMiddleware);

adminRouter.route('/', adminTiersRouter);
adminRouter.route('/', adminAssetsRouter);
adminRouter.route('/', adminApplicationsRouter);

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

adminRouter.get('/settings', async c => {
  const shopDomain = c.get('shopDomain');
  const row = await c.env.DB.prepare(
    `SELECT settings_json FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ settings_json: string }>();

  const blob = parseSettingsBlob(row?.settings_json);
  return c.json(pickAdminSettings(blob));
});

adminRouter.put('/settings', async c => {
  const shopDomain = c.get('shopDomain');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  let patch;
  try {
    patch = validateAdminSettingsPatch(body);
  } catch (err) {
    const message = err instanceof SettingsValidationError ? err.message : 'invalid payload';
    return c.json({ error: message }, 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT settings_json FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ settings_json: string }>();

  if (!row) return c.json({ error: 'shop not found' }, 404);

  const merged = mergeSettings(parseSettingsBlob(row.settings_json), patch);

  await c.env.DB.prepare(`UPDATE shops SET settings_json = ? WHERE shopify_domain = ?`)
    .bind(JSON.stringify(merged), shopDomain)
    .run();

  log('info', 'admin: settings updated', {
    shop: shopDomain,
    keys: Object.keys(patch),
  });

  return c.json(pickAdminSettings(merged));
});
