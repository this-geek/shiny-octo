/**
 * Buyer-facing wholesale application routes (App Proxy).
 *
 * Mounted under appProxyRouter so the App Proxy HMAC middleware runs first.
 * Routes:
 *   GET  /application/form-config             → form schema + turnstile config
 *   POST /application/autosave                → upsert draft, returns resume token
 *   GET  /application/resume?token=...        → return decrypted draft form
 *   POST /application/submit                  → submit (turnstile + validation)
 *   POST /application/document-upload         → start R2 multipart session
 *   PUT  /application/document-upload/:s/parts/:n
 *   POST /application/document-upload/:s/complete
 *
 * The form is callable by anonymous visitors (we're capturing leads). The
 * App Proxy HMAC is the only auth boundary — Shopify won't sign requests
 * for unrelated origins.
 */

import { Hono } from 'hono';
import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import {
  parseSettingsBlob,
  type ApplicationFormField,
  type ApplicationFormSettings,
} from '../lib/settings.js';
import {
  ApplicationStateError,
  submitApplication,
  upsertDraft,
  getApplicationDetail,
  type ApplicationDocument,
  type ApplicationFormData,
} from '../lib/application-store.js';
import { hasValidator, validateTaxId } from '../lib/tax-id-validators.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import {
  ResumeTokenError,
  signResumeToken,
  verifyResumeToken,
} from '../lib/resume-token.js';
import {
  deleteSession,
  loadSession,
  newSessionId,
  saveSession,
  type UploadedPart,
} from '../lib/r2-multipart.js';
import { isMimeAllowed, isSizeWithinLimit, inferAssetType } from '../lib/r2-keys.js';
import { enqueueApplicationEmail } from '../lib/internal-jobs.js';

export const appProxyApplicationsRouter = new Hono<{ Bindings: Env }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ShopRow {
  id: number;
  shopify_domain: string;
  settings_json: string;
}

async function resolveShop(env: Env, shopDomain: string): Promise<ShopRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, shopify_domain, settings_json FROM shops
     WHERE shopify_domain = ? AND uninstalled_at IS NULL`,
  )
    .bind(shopDomain)
    .first<ShopRow>();
  return row ?? null;
}

function readFormSettings(shop: ShopRow): ApplicationFormSettings {
  const blob = parseSettingsBlob(shop.settings_json);
  const f = (blob.applicationForm as ApplicationFormSettings | undefined) ?? null;
  if (f) return f;
  // Default form when the merchant hasn't configured one yet — keeps the
  // pre-onboarding flow useful so buyers can apply even before the merchant
  // finishes setup.
  return {
    fields: [
      { id: 'business_name', label: 'Business name', type: 'text', required: true },
      { id: 'phone', label: 'Phone', type: 'tel', required: false },
      { id: 'reseller_status', label: 'Are you a reseller?', type: 'select', required: true, options: ['Yes', 'No'] },
    ],
    requireDocuments: false,
  };
}

function pickShopDomain(c: { req: { query: (k: string) => string | undefined } }): string | null {
  return c.req.query('shop') ?? null;
}

// ---------------------------------------------------------------------------
// GET /application/form-config
// ---------------------------------------------------------------------------

appProxyApplicationsRouter.get('/application/form-config', async c => {
  const shopDomain = pickShopDomain(c);
  if (!shopDomain) return c.json({ error: 'missing shop' }, 400);

  const shop = await resolveShop(c.env, shopDomain);
  if (!shop) return c.json({ error: 'shop not installed' }, 404);

  const form = readFormSettings(shop);
  return c.json({
    fields: form.fields,
    requireDocuments: form.requireDocuments,
    turnstile: {
      enabled: Boolean(c.env.TURNSTILE_SECRET_KEY && c.env.TURNSTILE_SITE_KEY),
      siteKey: c.env.TURNSTILE_SITE_KEY ?? null,
    },
    // Surface the country with a registered tax-id validator so the buyer-side
    // UI can show a "format is wrong" hint while typing. Today: NZ only.
    taxIdCountries: ['nz'].filter(hasValidator),
  });
});

// ---------------------------------------------------------------------------
// POST /application/autosave
// ---------------------------------------------------------------------------

interface AutosaveBody {
  email?: unknown;
  resume_token?: unknown;
  form?: unknown;
}

function parseFormPayload(raw: unknown, fields: ApplicationFormField[]): ApplicationFormData {
  if (typeof raw !== 'object' || raw === null) {
    return { fields: {}, email: '', documents: [] };
  }
  const o = raw as Record<string, unknown>;
  const out: ApplicationFormData = {
    fields: {},
    email: typeof o.email === 'string' ? o.email : '',
    countryCode: typeof o.countryCode === 'string' ? o.countryCode : undefined,
    taxId: typeof o.taxId === 'string' ? o.taxId : undefined,
    gstNumber: typeof o.gstNumber === 'string' ? o.gstNumber : undefined,
    companyName: typeof o.companyName === 'string' ? o.companyName : undefined,
    documents: [],
  };
  const fieldsObj = o.fields as Record<string, unknown> | undefined;
  if (fieldsObj && typeof fieldsObj === 'object') {
    const allowedIds = new Set(fields.map(f => f.id));
    for (const [k, v] of Object.entries(fieldsObj)) {
      if (!allowedIds.has(k)) continue;
      if (typeof v === 'string') {
        // Cap each field value so a hostile payload can't blow up the
        // encrypted blob size.
        out.fields[k] = v.slice(0, 5000);
      }
    }
  }
  if (Array.isArray(o.documents)) {
    out.documents = o.documents.flatMap((d): ApplicationDocument[] => {
      if (typeof d !== 'object' || d === null) return [];
      const dd = d as Record<string, unknown>;
      if (
        typeof dd.name !== 'string' ||
        typeof dd.r2_key !== 'string' ||
        typeof dd.size !== 'number' ||
        typeof dd.mime !== 'string'
      ) {
        return [];
      }
      return [
        { name: dd.name.slice(0, 200), r2_key: dd.r2_key, size: dd.size, mime: dd.mime },
      ];
    });
  }
  return out;
}

appProxyApplicationsRouter.post('/application/autosave', async c => {
  const shopDomain = pickShopDomain(c);
  if (!shopDomain) return c.json({ error: 'missing shop' }, 400);

  const shop = await resolveShop(c.env, shopDomain);
  if (!shop) return c.json({ error: 'shop not installed' }, 404);

  let body: AutosaveBody;
  try {
    body = (await c.req.json()) as AutosaveBody;
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const formSettings = readFormSettings(shop);
  const form = parseFormPayload(body.form, formSettings.fields);

  // If we have a resume_token, derive the email from it (and trust it) so a
  // hostile autosave can't change the email on someone else's draft.
  let email: string;
  let existingAid: number | null = null;
  if (typeof body.resume_token === 'string' && body.resume_token.length > 0) {
    let payload;
    try {
      payload = await verifyResumeToken(
        body.resume_token,
        shopDomain,
        c.env.MASTER_KEY,
      );
    } catch (err) {
      if (err instanceof ResumeTokenError) {
        return c.json({ error: `resume token: ${err.message}` }, 401);
      }
      throw err;
    }
    email = payload.email;
    existingAid = payload.aid;
  } else {
    if (typeof body.email !== 'string' || !EMAIL_RE.test(body.email)) {
      return c.json({ error: 'valid email required for first autosave' }, 400);
    }
    email = body.email.toLowerCase();
  }

  const draft = await upsertDraft(c.env.DB, shop.id, shopDomain, c.env.MASTER_KEY, {
    email,
    form: { ...form, email },
  });

  // If the token referenced a specific application but upsertDraft picked a
  // different live draft for this email (shouldn't happen given the unique
  // index, but defensive), refuse instead of silently rewriting.
  if (existingAid !== null && existingAid !== draft.id) {
    return c.json({ error: 'resume token does not match the current draft' }, 409);
  }

  const resumeToken = await signResumeToken(
    draft.id,
    email,
    shopDomain,
    c.env.MASTER_KEY,
  );

  log('info', 'application: autosaved', {
    shop: shopDomain,
    application_id: draft.id,
    created: draft.created,
  });

  return c.json({
    application_id: draft.id,
    resume_token: resumeToken,
    created: draft.created,
  });
});

// ---------------------------------------------------------------------------
// GET /application/resume
// ---------------------------------------------------------------------------

appProxyApplicationsRouter.get('/application/resume', async c => {
  const shopDomain = pickShopDomain(c);
  if (!shopDomain) return c.json({ error: 'missing shop' }, 400);

  const shop = await resolveShop(c.env, shopDomain);
  if (!shop) return c.json({ error: 'shop not installed' }, 404);

  const token = c.req.query('token');
  if (!token) return c.json({ error: 'missing token' }, 400);

  let payload;
  try {
    payload = await verifyResumeToken(token, shopDomain, c.env.MASTER_KEY);
  } catch (err) {
    if (err instanceof ResumeTokenError) {
      return c.json({ error: `resume token: ${err.message}` }, 401);
    }
    throw err;
  }

  const detail = await getApplicationDetail(
    c.env.DB,
    shop.id,
    payload.aid,
    shopDomain,
    c.env.MASTER_KEY,
  );
  if (!detail || detail.email.toLowerCase() !== payload.email) {
    return c.json({ error: 'application not found' }, 404);
  }
  if (detail.status !== 'draft' && detail.status !== 'needs_info') {
    return c.json({ error: `application is ${detail.status}; cannot resume` }, 409);
  }

  return c.json({
    application_id: detail.id,
    status: detail.status,
    email: detail.email,
    form: detail.form,
    last_autosaved_at: detail.last_autosaved_at,
  });
});

// ---------------------------------------------------------------------------
// POST /application/submit
// ---------------------------------------------------------------------------

interface SubmitBody extends AutosaveBody {
  cf_turnstile_response?: unknown;
}

appProxyApplicationsRouter.post('/application/submit', async c => {
  const shopDomain = pickShopDomain(c);
  if (!shopDomain) return c.json({ error: 'missing shop' }, 400);

  const shop = await resolveShop(c.env, shopDomain);
  if (!shop) return c.json({ error: 'shop not installed' }, 404);

  let body: SubmitBody;
  try {
    body = (await c.req.json()) as SubmitBody;
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  // Turnstile (gated by env). Skipped silently when secret is absent — see
  // turnstile.ts for the policy.
  const remoteIp = c.req.header('CF-Connecting-IP') ?? null;
  const turnstileToken =
    typeof body.cf_turnstile_response === 'string' ? body.cf_turnstile_response : null;
  const ts = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, turnstileToken, remoteIp);
  if (!ts.ok) {
    log('warn', 'application: turnstile failed', {
      shop: shopDomain,
      codes: ts.errorCodes.join(','),
    });
    return c.json({ error: 'captcha failed', detail: ts.errorCodes }, 403);
  }
  if (ts.skipped) {
    log('warn', 'application: turnstile skipped (no secret configured)', {
      shop: shopDomain,
    });
  }

  const formSettings = readFormSettings(shop);
  const form = parseFormPayload(body.form, formSettings.fields);

  // Resolve which application we're submitting via the resume_token (preferred)
  // or by creating one on the spot from email (single-page form flow).
  let applicationId: number;
  let email: string;
  if (typeof body.resume_token === 'string' && body.resume_token.length > 0) {
    try {
      const payload = await verifyResumeToken(
        body.resume_token,
        shopDomain,
        c.env.MASTER_KEY,
      );
      applicationId = payload.aid;
      email = payload.email;
    } catch (err) {
      if (err instanceof ResumeTokenError) {
        return c.json({ error: `resume token: ${err.message}` }, 401);
      }
      throw err;
    }
  } else {
    if (typeof body.email !== 'string' || !EMAIL_RE.test(body.email)) {
      return c.json({ error: 'valid email required' }, 400);
    }
    email = body.email.toLowerCase();
    const draft = await upsertDraft(c.env.DB, shop.id, shopDomain, c.env.MASTER_KEY, {
      email,
      form: { ...form, email },
    });
    applicationId = draft.id;
  }

  // Required-field check against the merchant's form schema.
  for (const field of formSettings.fields) {
    if (!field.required) continue;
    const value = form.fields[field.id];
    if (!value || value.trim().length === 0) {
      return c.json({ error: `field ${field.id} is required` }, 400);
    }
  }
  if (formSettings.requireDocuments && form.documents.length === 0) {
    return c.json({ error: 'at least one document is required' }, 400);
  }

  // Tax-ID validation (format only).
  const tax = validateTaxId(form.countryCode, form.taxId, { field: 'taxId' });
  if (!tax.ok) return c.json({ error: tax.error }, 400);
  if (form.gstNumber) {
    const gst = validateTaxId(form.countryCode, form.gstNumber, { field: 'gstNumber' });
    if (!gst.ok) return c.json({ error: gst.error }, 400);
  }

  try {
    const row = await submitApplication(
      c.env.DB,
      shop.id,
      applicationId,
      shopDomain,
      c.env.MASTER_KEY,
      { ...form, email },
    );
    // Send a confirmation email asynchronously so the buyer-facing POST stays
    // fast and submission isn't blocked by Resend hiccups.
    await enqueueApplicationEmail(c.env, shopDomain, row.id, 'submitted');
    log('info', 'application: submitted', {
      shop: shopDomain,
      application_id: row.id,
    });
    return c.json({
      application_id: row.id,
      reference: applicationReference(shop.id, row.id),
      status: row.status,
    });
  } catch (err) {
    if (err instanceof ApplicationStateError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

function applicationReference(shopId: number, applicationId: number): string {
  // Human-readable confirmation code shown to the buyer; embeds the numeric
  // id so support can locate the row without a DB join.
  return `B2B-${shopId}-${applicationId.toString(36).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Document upload — multipart against R2. Same shape as the admin-asset
// uploader, but session is keyed by application id (verified via resume token).
// ---------------------------------------------------------------------------

interface DocUploadBody {
  resume_token?: unknown;
  filename?: unknown;
  mime_type?: unknown;
  total_size_bytes?: unknown;
}

function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'upload';
}

async function resolveApplicationFromToken(
  c: { req: { json: () => Promise<unknown> } } | { token: string },
  env: Env,
  shopDomain: string,
  token: string,
): Promise<{ aid: number; email: string } | { error: Response }> {
  try {
    const payload = await verifyResumeToken(token, shopDomain, env.MASTER_KEY);
    return { aid: payload.aid, email: payload.email };
  } catch (err) {
    const msg = err instanceof ResumeTokenError ? err.message : 'invalid token';
    return {
      error: new Response(JSON.stringify({ error: `resume token: ${msg}` }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }
}

appProxyApplicationsRouter.post('/application/document-upload', async c => {
  const shopDomain = pickShopDomain(c);
  if (!shopDomain) return c.json({ error: 'missing shop' }, 400);

  const shop = await resolveShop(c.env, shopDomain);
  if (!shop) return c.json({ error: 'shop not installed' }, 404);

  let body: DocUploadBody;
  try {
    body = (await c.req.json()) as DocUploadBody;
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (typeof body.resume_token !== 'string') {
    return c.json({ error: 'resume_token required' }, 400);
  }
  if (typeof body.filename !== 'string' || body.filename.length === 0) {
    return c.json({ error: 'filename required' }, 400);
  }
  if (typeof body.mime_type !== 'string' || !isMimeAllowed(body.mime_type)) {
    return c.json({ error: 'mime_type missing or not allowed' }, 400);
  }
  if (
    typeof body.total_size_bytes !== 'number' ||
    !Number.isFinite(body.total_size_bytes) ||
    body.total_size_bytes <= 0
  ) {
    return c.json({ error: 'total_size_bytes must be positive' }, 400);
  }
  const t = inferAssetType(body.mime_type);
  if (t && !isSizeWithinLimit(t, body.total_size_bytes)) {
    return c.json({ error: `${t} exceeds size limit` }, 400);
  }

  const tokenRes = await resolveApplicationFromToken(c, c.env, shopDomain, body.resume_token);
  if ('error' in tokenRes) return tokenRes.error;

  const sessionId = newSessionId();
  const key = `shops/${shop.id}/applications/${tokenRes.aid}/${sessionId}-${sanitiseFilename(body.filename)}`;
  let multipart;
  try {
    multipart = await c.env.ASSETS_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: body.mime_type },
    });
  } catch (err) {
    log('error', 'application doc upload: createMultipartUpload failed', {
      shop: shopDomain,
      error: String(err),
    });
    return c.json({ error: 'failed to start upload' }, 502);
  }

  await saveSession(c.env.KV_IDEMPOTENCY, sessionId, {
    shop_id: shop.id,
    key,
    upload_id: multipart.uploadId,
    filename: body.filename,
    mime_type: body.mime_type,
    total_size_bytes: body.total_size_bytes,
    created_at: Math.floor(Date.now() / 1000),
  });

  return c.json({
    session_id: sessionId,
    key,
    recommended_part_size: 64 * 1024 * 1024,
  });
});

appProxyApplicationsRouter.put(
  '/application/document-upload/:sessionId/parts/:partNumber',
  async c => {
    const shopDomain = pickShopDomain(c);
    if (!shopDomain) return c.json({ error: 'missing shop' }, 400);
    const shop = await resolveShop(c.env, shopDomain);
    if (!shop) return c.json({ error: 'shop not installed' }, 404);

    const sessionId = c.req.param('sessionId');
    const partNumber = Number.parseInt(c.req.param('partNumber'), 10);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      return c.json({ error: 'partNumber must be 1-10000' }, 400);
    }
    const session = await loadSession(c.env.KV_IDEMPOTENCY, shop.id, sessionId);
    if (!session) return c.json({ error: 'session not found or expired' }, 404);

    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'request body required' }, 400);

    try {
      const multipart = c.env.ASSETS_BUCKET.resumeMultipartUpload(
        session.key,
        session.upload_id,
      );
      const part = await multipart.uploadPart(partNumber, body);
      return c.json({ partNumber: part.partNumber, etag: part.etag });
    } catch (err) {
      log('error', 'application doc upload: uploadPart failed', {
        shop: shopDomain,
        session: sessionId,
        part: partNumber,
        error: String(err),
      });
      return c.json({ error: 'failed to upload part' }, 502);
    }
  },
);

appProxyApplicationsRouter.post(
  '/application/document-upload/:sessionId/complete',
  async c => {
    const shopDomain = pickShopDomain(c);
    if (!shopDomain) return c.json({ error: 'missing shop' }, 400);
    const shop = await resolveShop(c.env, shopDomain);
    if (!shop) return c.json({ error: 'shop not installed' }, 404);

    const sessionId = c.req.param('sessionId');
    const session = await loadSession(c.env.KV_IDEMPOTENCY, shop.id, sessionId);
    if (!session) return c.json({ error: 'session not found or expired' }, 404);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parts = (body as { parts?: unknown }).parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      return c.json({ error: 'parts must be a non-empty array' }, 400);
    }
    const uploaded: UploadedPart[] = parts.map(p => {
      const pp = p as Record<string, unknown>;
      return { partNumber: pp.partNumber as number, etag: pp.etag as string };
    });

    try {
      const multipart = c.env.ASSETS_BUCKET.resumeMultipartUpload(
        session.key,
        session.upload_id,
      );
      await multipart.complete(uploaded);
    } catch (err) {
      log('error', 'application doc upload: complete failed', {
        shop: shopDomain,
        session: sessionId,
        error: String(err),
      });
      return c.json({ error: 'failed to finalise upload' }, 502);
    }

    await deleteSession(c.env.KV_IDEMPOTENCY, shop.id, sessionId);
    return c.json({
      key: session.key,
      mime_type: session.mime_type,
      total_size_bytes: session.total_size_bytes,
    });
  },
);
