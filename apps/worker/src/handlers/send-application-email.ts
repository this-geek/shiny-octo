/**
 * Queue consumer: send a transactional email for an application state change.
 *
 * Pulls the merchant's stored template from `shops.settings_json` and falls
 * back to a sensible default when the merchant hasn't customised one yet.
 * Retryable Resend errors bubble up so the queue redelivers; recognised
 * (non-retryable) errors are logged and acked.
 */

import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import { parseSettingsBlob, type EmailTemplate } from '../lib/settings.js';
import {
  RecognisedSendError,
  renderTemplate,
  sendEmail,
} from '../lib/email-resend.js';
import {
  getApplicationDetail,
  type ApplicationDetail,
} from '../lib/application-store.js';
import { signResumeToken } from '../lib/resume-token.js';
import type { ApplicationEmailKind } from '../lib/internal-jobs.js';

export interface SendApplicationEmailPayload {
  application_id: number;
  kind: ApplicationEmailKind;
}

const DEFAULT_TEMPLATES: Record<ApplicationEmailKind, EmailTemplate> = {
  submitted: {
    subject: 'We received your wholesale application',
    body:
      '<p>Hi {{companyName}},</p><p>We received your wholesale application (reference {{reference}}). ' +
      'Our team will review it and get back to you. No action needed for now.</p>',
  },
  approved: {
    subject: 'Your wholesale application is approved',
    body:
      '<p>Hi {{companyName}},</p><p>Your wholesale account is ready. ' +
      '{{magicLinkParagraph}}</p><p>Once you sign in, your dealer portal is at ' +
      '<a href="{{accountUrl}}">{{accountUrl}}</a>.</p>',
  },
  rejected: {
    subject: 'Update on your wholesale application',
    body:
      "<p>Hi {{companyName}},</p><p>Thanks for applying. We're not able to approve your wholesale " +
      'account at this time.</p><p>{{notes}}</p>',
  },
  needs_info: {
    subject: 'We need more information for your wholesale application',
    body:
      '<p>Hi {{companyName}},</p><p>Thanks for applying. Before we can decide, we need a bit ' +
      'more information:</p><p>{{notes}}</p><p>Resume your application: ' +
      '<a href="{{resumeUrl}}">{{resumeUrl}}</a></p>',
  },
  nudge_14d: {
    subject: 'Your wholesale account is ready when you are',
    body:
      "<p>Hi {{companyName}},</p><p>Just a quick check-in — it's been a couple of weeks since " +
      "we approved your wholesale account and we haven't seen an order yet. If you need a hand " +
      'placing your first order or have questions about pricing or shipping, hit reply and ' +
      'someone from our team will be in touch.</p><p>Your account: ' +
      '<a href="{{accountUrl}}">{{accountUrl}}</a>.</p>',
  },
  nudge_30d: {
    subject: 'Anything we can help with on your wholesale account?',
    body:
      "<p>Hi {{companyName}},</p><p>You've had wholesale access for about a month now. If " +
      "there's anything blocking your first order — pricing, shipping, an asset you need, " +
      'a product not yet available at wholesale — let us know and we will do our best to ' +
      'unblock it.</p><p>Sign in: <a href="{{accountUrl}}">{{accountUrl}}</a>.</p>',
  },
  nudge_60d: {
    subject: 'Keeping your wholesale account active',
    body:
      "<p>Hi {{companyName}},</p><p>It's been about two months since we approved your " +
      "wholesale account. We'd love to keep it open for you — just let us know if you'd " +
      "like us to deactivate it or if there's something we can do to help you get your " +
      'first order placed.</p><p>Sign in: <a href="{{accountUrl}}">{{accountUrl}}</a>.</p>',
  },
};

function pickTemplate(
  env: Env,
  shop: { settings_json: string },
  kind: ApplicationEmailKind,
): EmailTemplate {
  const blob = parseSettingsBlob(shop.settings_json);
  const templates = blob.emailTemplates as Record<string, EmailTemplate> | undefined;
  const key = kind === 'needs_info' ? 'moreInfo' : kind;
  const custom = templates?.[key];
  return custom ?? DEFAULT_TEMPLATES[kind];
}

function applyPathFromSettings(shop: { settings_json: string }): string {
  const blob = parseSettingsBlob(shop.settings_json);
  const ap = blob.app_proxy as { applyPath?: string } | undefined;
  return ap?.applyPath?.trim() || '/pages/wholesale-apply';
}

export async function sendApplicationEmailHandler(
  shopDomain: string,
  payload: SendApplicationEmailPayload,
  env: Env,
): Promise<void> {
  const shopRow = await env.DB.prepare(
    `SELECT id, shopify_domain, settings_json FROM shops
     WHERE shopify_domain = ? AND uninstalled_at IS NULL`,
  )
    .bind(shopDomain)
    .first<{ id: number; shopify_domain: string; settings_json: string }>();
  if (!shopRow) {
    log('warn', 'send-application-email: shop missing or uninstalled', { shop: shopDomain });
    return;
  }

  const detail = await getApplicationDetail(
    env.DB,
    shopRow.id,
    payload.application_id,
    shopDomain,
    env.MASTER_KEY,
  );
  if (!detail) {
    log('warn', 'send-application-email: application row not found', {
      shop: shopDomain,
      application_id: payload.application_id,
    });
    return;
  }

  const from = env.EMAIL_FROM;
  if (!from) {
    log('warn', 'send-application-email: EMAIL_FROM not configured, skipping', {
      shop: shopDomain,
      application_id: payload.application_id,
    });
    return;
  }

  const template = pickTemplate(env, shopRow, payload.kind);
  const vars = await buildTemplateVars(env, shopRow, shopDomain, detail, payload.kind);

  const subject = renderTemplate(template.subject, vars);
  const html = renderTemplate(template.body, vars);

  try {
    await sendEmail(env.RESEND_API_KEY, {
      from,
      to: detail.email,
      subject,
      html,
    });
    log('info', 'send-application-email: sent', {
      shop: shopDomain,
      application_id: detail.id,
      kind: payload.kind,
    });
  } catch (err) {
    if (err instanceof RecognisedSendError) {
      // Don't retry on auth / 4xx. Log and let the queue ack.
      log('error', 'send-application-email: non-retryable', {
        shop: shopDomain,
        application_id: detail.id,
        kind: payload.kind,
        error: err.message,
      });
      return;
    }
    // Retryable: rethrow so the queue redelivers.
    throw err;
  }
}

async function buildTemplateVars(
  env: Env,
  shopRow: { id: number; settings_json: string },
  shopDomain: string,
  detail: ApplicationDetail,
  kind: ApplicationEmailKind,
): Promise<Record<string, string>> {
  const reference = `B2B-${detail.shop_id}-${detail.id.toString(36).toUpperCase()}`;
  const shopOrigin = `https://${shopDomain}`;
  const accountUrl = `${shopOrigin}/account`;
  let resumeUrl = '';
  if (kind === 'needs_info') {
    const applyPath = applyPathFromSettings(shopRow);
    const token = await signResumeToken(detail.id, detail.email, shopDomain, env.MASTER_KEY);
    resumeUrl = `${shopOrigin}${applyPath}?resume=${encodeURIComponent(token)}`;
  }
  return {
    companyName: detail.form.companyName ?? 'there',
    email: detail.email,
    reference,
    notes: detail.decision_notes ?? '',
    shopDomain,
    shopOrigin,
    accountUrl,
    magicLinkParagraph:
      kind === 'approved'
        ? "We've sent a sign-in link to this address separately — open it to set your " +
          'password and place your first order.'
        : '',
    resumeUrl,
  };
}

