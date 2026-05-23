import { Hono } from 'hono';
import type { Env } from '../types.js';
import {
  createTier,
  getTier,
  listActiveTiers,
  softDeleteTier,
  updateTier,
  validateTierInput,
  TierValidationError,
} from '../lib/tier-store.js';
import {
  CompanyMappingValidationError,
  deleteMapping,
  listMappings,
  upsertMapping,
} from '../lib/company-mapping-store.js';
import {
  enqueueCompanyTierMirror,
  enqueueTiersConfigPublish,
} from '../lib/internal-jobs.js';
import { getShopAuth } from '../lib/shop-token.js';
import { listShopifyCompanies } from '../lib/shopify-companies.js';
import { log } from '../lib/logger.js';

// Mounted under adminRouter, which applies sessionTokenMiddleware globally.
export const adminTiersRouter = new Hono<{ Bindings: Env }>();

async function resolveShopId(env: Env, shopDomain: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ id: number }>();
  return row?.id ?? null;
}

adminTiersRouter.get('/tiers', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);
  const tiers = await listActiveTiers(c.env.DB, shopId);
  return c.json({ tiers });
});

adminTiersRouter.post('/tiers', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  let input;
  try {
    input = validateTierInput(body);
  } catch (err) {
    const message = err instanceof TierValidationError ? err.message : 'invalid payload';
    return c.json({ error: message }, 400);
  }

  const tier = await createTier(c.env.DB, shopId, input);
  await enqueueTiersConfigPublish(c.env, shopDomain);
  log('info', 'admin: tier created', { shop: shopDomain, tier_id: tier.id });
  return c.json({ tier }, 201);
});

adminTiersRouter.put('/tiers/:id', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'invalid tier id' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  let input;
  try {
    input = validateTierInput(body);
  } catch (err) {
    const message = err instanceof TierValidationError ? err.message : 'invalid payload';
    return c.json({ error: message }, 400);
  }

  const tier = await updateTier(c.env.DB, shopId, id, input);
  if (!tier) return c.json({ error: 'tier not found' }, 404);

  await enqueueTiersConfigPublish(c.env, shopDomain);
  log('info', 'admin: tier updated', { shop: shopDomain, tier_id: id });
  return c.json({ tier });
});

adminTiersRouter.delete('/tiers/:id', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'invalid tier id' }, 400);
  }

  const tier = await getTier(c.env.DB, shopId, id);
  if (!tier || tier.deleted_at !== null) {
    return c.json({ error: 'tier not found' }, 404);
  }

  const removed = await softDeleteTier(c.env.DB, shopId, id);
  if (!removed) return c.json({ error: 'tier not found' }, 404);

  await enqueueTiersConfigPublish(c.env, shopDomain);
  log('info', 'admin: tier deleted', { shop: shopDomain, tier_id: id });
  return c.json({ ok: true });
});

adminTiersRouter.get('/shopify-companies', async c => {
  const shopDomain = c.get('shopDomain');
  const auth = await getShopAuth(c.env, shopDomain);
  if (!auth) return c.json({ error: 'shop not found' }, 404);
  try {
    const result = await listShopifyCompanies(
      shopDomain,
      auth.token,
      c.env.SHOPIFY_API_VERSION,
    );
    return c.json(result);
  } catch (err) {
    log('error', 'admin: listShopifyCompanies failed', {
      shop: shopDomain,
      error: String(err),
    });
    return c.json({ error: 'could not list Shopify companies' }, 502);
  }
});

adminTiersRouter.get('/company-mappings', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);
  const mappings = await listMappings(c.env.DB, shopId);
  return c.json({ mappings });
});

adminTiersRouter.put('/company-mappings/:companyGid', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const companyGid = decodeURIComponent(c.req.param('companyGid'));
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const { tier_id, credit_limit } = (body ?? {}) as {
    tier_id?: unknown;
    credit_limit?: unknown;
  };

  if (!Number.isInteger(tier_id) || (tier_id as number) <= 0) {
    return c.json({ error: 'tier_id must be a positive integer' }, 400);
  }
  if (
    credit_limit !== null &&
    credit_limit !== undefined &&
    (typeof credit_limit !== 'number' ||
      !Number.isFinite(credit_limit) ||
      credit_limit < 0)
  ) {
    return c.json({ error: 'credit_limit must be a non-negative number or null' }, 400);
  }

  const tier = await getTier(c.env.DB, shopId, tier_id as number);
  if (!tier || tier.deleted_at !== null) {
    return c.json({ error: 'tier not found' }, 404);
  }

  try {
    const mapping = await upsertMapping(
      c.env.DB,
      shopId,
      companyGid,
      tier_id as number,
      (credit_limit as number | null | undefined) ?? null,
    );
    await enqueueCompanyTierMirror(c.env, shopDomain, companyGid, tier_id as number);
    log('info', 'admin: company mapping upserted', {
      shop: shopDomain,
      company: companyGid,
      tier_id,
    });
    return c.json({ mapping });
  } catch (err) {
    if (err instanceof CompanyMappingValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

adminTiersRouter.delete('/company-mappings/:companyGid', async c => {
  const shopDomain = c.get('shopDomain');
  const shopId = await resolveShopId(c.env, shopDomain);
  if (shopId === null) return c.json({ error: 'shop not found' }, 404);

  const companyGid = decodeURIComponent(c.req.param('companyGid'));
  try {
    const removed = await deleteMapping(c.env.DB, shopId, companyGid);
    if (!removed) return c.json({ error: 'mapping not found' }, 404);
    await enqueueCompanyTierMirror(c.env, shopDomain, companyGid, null);
    log('info', 'admin: company mapping deleted', {
      shop: shopDomain,
      company: companyGid,
    });
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof CompanyMappingValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});
