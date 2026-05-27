/**
 * Queue consumer: email the customer-data-export bundle to the shop owner.
 *
 * Triggered by the sweep when a `customer_data_request` row becomes due.
 * Shopify's model: the merchant — not us — has the buyer's contact channel,
 * so we deliver the data to the shop's configured owner email and let them
 * forward it to the buyer within the 30-day legal window.
 *
 * Retries inherit the queue policy. We treat a missing EMAIL_FROM as a
 * recognised (non-retryable) failure so the sweep surfaces the misconfig
 * via `gdpr_requests.last_error` rather than churning the queue.
 */

import type { Env } from '../types.js';
import { log } from '../lib/logger.js';
import {
  RecognisedSendError,
  renderTemplate,
  sendEmail,
} from '../lib/email-resend.js';
import { exportCustomerData } from '../lib/gdpr-purge.js';
import { getGdprRequest } from '../lib/gdpr-store.js';

export interface SendGdprExportPayload {
  gdpr_request_id: string;
}

const SUBJECT = 'GDPR data request for customer {{customerId}}';

const BODY_HTML =
  '<p>This shop received a Shopify <code>customers/data_request</code> webhook.</p>' +
  '<p><strong>Shop:</strong> {{shopDomain}}<br/>' +
  '<strong>Shopify customer id:</strong> {{customerId}}<br/>' +
  '<strong>Generated at:</strong> {{exportedAt}}</p>' +
  '<p>The buyer\'s data held by this app is attached as JSON. Per Shopify\'s ' +
  'privacy policy you have up to 30 days to forward it to the buyer. ' +
  'Document files referenced in the bundle remain in the asset bucket ' +
  'until the corresponding customer/redact webhook fires.</p>' +
  '<pre style="white-space:pre-wrap;font-family:monospace;background:#f5f5f5;padding:12px;border-radius:4px">{{bundleJson}}</pre>';

export async function sendGdprExportHandler(
  shopDomain: string,
  payload: SendGdprExportPayload,
  env: Env,
): Promise<void> {
  const request = await getGdprRequest(env.DB, payload.gdpr_request_id);
  if (!request) {
    log('warn', 'send-gdpr-export: request row missing', {
      shop: shopDomain,
      gdpr_request_id: payload.gdpr_request_id,
    });
    return;
  }
  if (request.shop_id === null || !request.shopify_customer_id) {
    log('warn', 'send-gdpr-export: incomplete request (no shop/customer)', {
      shop: shopDomain,
      gdpr_request_id: payload.gdpr_request_id,
    });
    return;
  }

  const shopRow = await env.DB.prepare(
    `SELECT id, shopify_domain FROM shops WHERE id = ?`,
  )
    .bind(request.shop_id)
    .first<{ id: number; shopify_domain: string }>();
  if (!shopRow) {
    log('warn', 'send-gdpr-export: shop already purged', {
      shop: shopDomain,
      gdpr_request_id: payload.gdpr_request_id,
    });
    return;
  }

  const recipient = await resolveOwnerEmail(env, shopRow.shopify_domain);
  if (!recipient) {
    throw new Error('owner email unavailable from settings or Shopify shop record');
  }

  const from = env.EMAIL_FROM;
  if (!from) {
    throw new Error('EMAIL_FROM not configured; cannot deliver GDPR export');
  }

  const bundle = await exportCustomerData(
    env,
    shopRow.id,
    shopRow.shopify_domain,
    request.shopify_customer_id,
  );
  const bundleJson = JSON.stringify(bundle, null, 2);

  const vars = {
    customerId: request.shopify_customer_id,
    shopDomain: shopRow.shopify_domain,
    exportedAt: new Date(bundle.exported_at * 1000).toISOString(),
    bundleJson,
  };

  try {
    await sendEmail(env.RESEND_API_KEY, {
      from,
      to: recipient,
      subject: renderTemplate(SUBJECT, vars),
      html: renderTemplate(BODY_HTML, vars),
    });
    log('info', 'send-gdpr-export: sent', {
      shop: shopRow.shopify_domain,
      gdpr_request_id: payload.gdpr_request_id,
      applications: bundle.applications.length,
      asset_downloads: bundle.asset_downloads.length,
      documents: bundle.documents.length,
    });
  } catch (err) {
    if (err instanceof RecognisedSendError) {
      log('error', 'send-gdpr-export: non-retryable send error', {
        shop: shopRow.shopify_domain,
        gdpr_request_id: payload.gdpr_request_id,
        error: err.message,
      });
      throw err;
    }
    throw err;
  }
}

/**
 * Pull the owner email from `shops.settings_json.gdpr.contactEmail` if set
 * by the merchant; otherwise fall back to the Shopify Shop.email field.
 */
async function resolveOwnerEmail(env: Env, shopDomain: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT settings_json FROM shops WHERE shopify_domain = ?`,
  )
    .bind(shopDomain)
    .first<{ settings_json: string }>();
  if (row?.settings_json) {
    try {
      const blob = JSON.parse(row.settings_json) as { gdpr?: { contactEmail?: string } };
      const email = blob.gdpr?.contactEmail;
      if (typeof email === 'string' && email.includes('@')) return email;
    } catch {
      // fall through to Shopify lookup
    }
  }
  return null;
}
