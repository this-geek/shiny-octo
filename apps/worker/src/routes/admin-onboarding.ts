/**
 * Phase 1I — Merchant onboarding wizard.
 *
 * Six-step wizard (Step 2 from §6 is omitted per DECISIONS #12: the ~20
 * wholesale-tagged pilot customers are imported manually). State lives in
 * `shops.settings_json.onboarding` so it survives reinstall and shares the
 * shallow-merge guarantees of the rest of the settings blob.
 *
 *   GET    /admin/onboarding/state                     → full state + detected facts
 *   POST   /admin/onboarding/detect                    → runs Step 1 Shopify queries
 *   POST   /admin/onboarding/step/:id/complete         → mark step done (+ data)
 *   POST   /admin/onboarding/step/:id/skip             → mark skippable step skipped
 *   POST   /admin/onboarding/dismiss                   → exit the wizard entirely
 *   POST   /admin/onboarding/finish                    → mark complete (all required done)
 *   POST   /admin/onboarding/test-buyer/create         → Step 6 helper
 *   POST   /admin/onboarding/test-buyer/:cid/invite    → resend magic link
 *
 * Auth: admin session token (shared with the rest of /admin/*).
 */

import { Hono } from 'hono';
import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import { getShopAuth } from '../lib/shop-token.js';
import { mergeSettings, parseSettingsBlob } from '../lib/settings.js';
import type { SettingsBlob } from '../lib/settings.js';
import {
  ONBOARDING_STEPS,
  SKIPPABLE_STEPS,
  type OnboardingStepId,
  type OnboardingState,
  completeOnboarding,
  defaultOnboardingState,
  dismissOnboarding,
  markStepDone,
  markStepSkipped,
  readOnboardingState,
  writeOnboardingState,
} from '../lib/onboarding-store.js';
import { detectExistingSetup } from '../lib/shopify-detect.js';
import {
  createCompanyForApplication,
  CompanyCreateError,
} from '../lib/shopify-companies-create.js';
import { sendCustomerInvite, CustomerInviteError } from '../lib/shopify-customer-invite.js';

export const adminOnboardingRouter = new Hono<{ Bindings: Env }>();

function isStepId(value: string): value is OnboardingStepId {
  return (ONBOARDING_STEPS as readonly string[]).includes(value);
}

async function loadSettingsBlob(env: Env, shopDomain: string): Promise<SettingsBlob> {
  const row = await env.DB.prepare(
    `SELECT settings_json FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ settings_json: string }>();
  return parseSettingsBlob(row?.settings_json);
}

async function saveSettingsBlob(
  env: Env,
  shopDomain: string,
  blob: SettingsBlob,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE shops SET settings_json = ? WHERE shopify_domain = ?`,
  )
    .bind(JSON.stringify(blob), shopDomain)
    .run();
}

async function saveState(
  env: Env,
  shopDomain: string,
  state: OnboardingState,
): Promise<void> {
  const blob = await loadSettingsBlob(env, shopDomain);
  const next = writeOnboardingState(blob, state);
  await saveSettingsBlob(env, shopDomain, next);
}

adminOnboardingRouter.get('/onboarding/state', async c => {
  const shopDomain = c.get('shopDomain');
  const blob = await loadSettingsBlob(c.env, shopDomain);
  const state = readOnboardingState(blob);
  return c.json({
    state,
    skippable: Array.from(SKIPPABLE_STEPS),
    steps: ONBOARDING_STEPS,
  });
});

adminOnboardingRouter.post('/onboarding/detect', async c => {
  const shopDomain = c.get('shopDomain');
  const auth = await getShopAuth(c.env, shopDomain);
  if (!auth) return c.json({ error: 'shop auth unavailable' }, 502);

  let detected;
  try {
    detected = await detectExistingSetup(shopDomain, auth.token, c.env.SHOPIFY_API_VERSION);
  } catch (err) {
    log('warn', 'onboarding: detect failed', { shop: shopDomain, error: String(err) });
    return c.json({ error: 'shopify lookup failed' }, 502);
  }

  const blob = await loadSettingsBlob(c.env, shopDomain);
  const state = readOnboardingState(blob);
  const next = markStepDone(state, 'detect', { detected });
  await saveState(c.env, shopDomain, next);
  log('info', 'onboarding: detect complete', {
    shop: shopDomain,
    companies: detected.companies,
    catalogs: detected.catalogs,
    markets: detected.markets,
    wholesale_customers: detected.wholesale_tagged_customers,
  });
  return c.json({ state: next, detected });
});

adminOnboardingRouter.post('/onboarding/step/:id/complete', async c => {
  const shopDomain = c.get('shopDomain');
  const id = c.req.param('id');
  if (!isStepId(id)) return c.json({ error: 'unknown step' }, 400);

  let body: { data?: Record<string, unknown> } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as { data?: Record<string, unknown> };
  } catch {
    body = {};
  }

  const blob = await loadSettingsBlob(c.env, shopDomain);
  const state = readOnboardingState(blob);
  const data = body.data && typeof body.data === 'object' ? body.data : undefined;
  const next = markStepDone(state, id, data);
  await saveState(c.env, shopDomain, next);
  log('info', 'onboarding: step complete', { shop: shopDomain, step: id });
  return c.json({ state: next });
});

adminOnboardingRouter.post('/onboarding/step/:id/skip', async c => {
  const shopDomain = c.get('shopDomain');
  const id = c.req.param('id');
  if (!isStepId(id)) return c.json({ error: 'unknown step' }, 400);
  if (!SKIPPABLE_STEPS.has(id)) return c.json({ error: 'step not skippable' }, 400);

  const blob = await loadSettingsBlob(c.env, shopDomain);
  const state = readOnboardingState(blob);
  const next = markStepSkipped(state, id);
  await saveState(c.env, shopDomain, next);
  log('info', 'onboarding: step skipped', { shop: shopDomain, step: id });
  return c.json({ state: next });
});

adminOnboardingRouter.post('/onboarding/dismiss', async c => {
  const shopDomain = c.get('shopDomain');
  const blob = await loadSettingsBlob(c.env, shopDomain);
  const state = readOnboardingState(blob);
  const next = dismissOnboarding(state);
  await saveState(c.env, shopDomain, next);
  log('info', 'onboarding: dismissed', { shop: shopDomain });
  return c.json({ state: next });
});

adminOnboardingRouter.post('/onboarding/finish', async c => {
  const shopDomain = c.get('shopDomain');
  const blob = await loadSettingsBlob(c.env, shopDomain);
  const state = readOnboardingState(blob);
  try {
    const next = completeOnboarding(state);
    await saveState(c.env, shopDomain, next);
    log('info', 'onboarding: completed', { shop: shopDomain });
    return c.json({ state: next });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

adminOnboardingRouter.post('/onboarding/reset', async c => {
  const shopDomain = c.get('shopDomain');
  const next = defaultOnboardingState();
  await saveState(c.env, shopDomain, next);
  log('info', 'onboarding: reset', { shop: shopDomain });
  return c.json({ state: next });
});

function shopHandleFromDomain(shopDomain: string): string {
  return shopDomain.replace(/\.myshopify\.com$/, '').toLowerCase().replace(/[^a-z0-9]/g, '-');
}

/**
 * Step 6 — create the merchant's test buyer.
 * Email follows DECISIONS #15: test-buyer+<shop-handle>@<our-sending-domain>
 * which is a catch-all on our verified Resend domain (EMAIL_FROM env var).
 * Creates Customer + Company + Contact in one companyCreate mutation, then
 * triggers the magic-link invite. Idempotent at the Shopify layer (we pass a
 * deterministic X-Idempotency-Key — see shopify-companies-create.ts), and
 * idempotent on our side because we persist the IDs into the step's `data`.
 */
adminOnboardingRouter.post('/onboarding/test-buyer/create', async c => {
  const shopDomain = c.get('shopDomain');
  const auth = await getShopAuth(c.env, shopDomain);
  if (!auth) return c.json({ error: 'shop auth unavailable' }, 502);

  const emailDomain = (c.env.EMAIL_FROM ?? '').split('@')[1] ?? null;
  if (!emailDomain) {
    return c.json({ error: 'EMAIL_FROM env var must be set to issue test-buyer emails' }, 400);
  }
  const handle = shopHandleFromDomain(shopDomain);
  const email = `test-buyer+${handle}@${emailDomain}`;

  // We pass a unique externalApplicationId so re-running this in a different
  // shop install doesn't collide with an earlier test buyer's Shopify
  // idempotency key. The handle suffix gives us shop-uniqueness; the constant
  // base ensures *within the same shop* a re-run hits the same key and
  // Shopify de-dupes the Company.
  const externalId = Math.abs(
    handle.split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0xb2bc0000),
  );

  let created;
  try {
    created = await createCompanyForApplication(
      shopDomain,
      auth.token,
      c.env.SHOPIFY_API_VERSION,
      {
        email,
        companyName: `B2B Companion test buyer (${handle})`,
        externalApplicationId: externalId,
        note: 'Created by B2B Companion onboarding wizard (Step 6)',
      },
    );
  } catch (err) {
    if (err instanceof CompanyCreateError) {
      log('warn', 'onboarding: test-buyer companyCreate failed', {
        shop: shopDomain,
        error: err.message,
      });
      return c.json({ error: err.message, userErrors: err.userErrors }, 502);
    }
    throw err;
  }

  let inviteResult: { sent: boolean; reason?: string } = { sent: false };
  if (created.customerId) {
    try {
      await sendCustomerInvite(
        shopDomain,
        auth.token,
        c.env.SHOPIFY_API_VERSION,
        created.customerId,
      );
      inviteResult = { sent: true };
    } catch (err) {
      const reason = err instanceof CustomerInviteError ? err.message : String(err);
      log('warn', 'onboarding: test-buyer invite failed', { shop: shopDomain, reason });
      inviteResult = { sent: false, reason };
    }
  }

  const blob = await loadSettingsBlob(c.env, shopDomain);
  const state = readOnboardingState(blob);
  const next = markStepDone(state, 'test_buyer', {
    email,
    company_id: created.companyId,
    customer_id: created.customerId,
    invite_sent: inviteResult.sent,
    invite_reason: inviteResult.reason,
  });
  await saveState(c.env, shopDomain, next);

  log('info', 'onboarding: test-buyer created', {
    shop: shopDomain,
    company: created.companyId,
    invite_sent: inviteResult.sent,
  });

  return c.json({
    state: next,
    email,
    customer_id: created.customerId,
    company_id: created.companyId,
    invite: inviteResult,
  });
});

adminOnboardingRouter.post('/onboarding/test-buyer/:cid/invite', async c => {
  const shopDomain = c.get('shopDomain');
  const customerId = c.req.param('cid');
  if (!customerId.startsWith('gid://shopify/Customer/')) {
    return c.json({ error: 'invalid customer GID' }, 400);
  }
  const auth = await getShopAuth(c.env, shopDomain);
  if (!auth) return c.json({ error: 'shop auth unavailable' }, 502);

  try {
    await sendCustomerInvite(shopDomain, auth.token, c.env.SHOPIFY_API_VERSION, customerId);
    log('info', 'onboarding: invite resent', { shop: shopDomain });
    return c.json({ ok: true });
  } catch (err) {
    const reason = err instanceof CustomerInviteError ? err.message : String(err);
    return c.json({ error: reason }, 502);
  }
});
