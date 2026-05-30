import type { Env } from '../types.js';
import {
  INTERNAL_PUBLISH_TIERS_CONFIG,
  INTERNAL_PUBLISH_PRICE_DISPLAY,
  INTERNAL_MIRROR_COMPANY_TIER,
  INTERNAL_SEND_APPLICATION_EMAIL,
  INTERNAL_SEND_GDPR_EXPORT,
} from '../routes/webhooks.js';

export type ApplicationEmailKind =
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'needs_info'
  | NudgeKind;

export type NudgeKind = 'nudge_14d' | 'nudge_30d' | 'nudge_60d';

interface InternalJobMessage {
  id: string;
  topic: string;
  shop_domain: string;
  body: string;
}

function newId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(rand, b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${Date.now()}-${hex}`;
}

/**
 * Enqueue a republish of `b2b.tiers_config`. Fire after every tier CRUD
 * mutation. The queue consumer fetches the current tier set and writes
 * the Shop metafield. Failures are retried by the queue.
 */
export async function enqueueTiersConfigPublish(
  env: Env,
  shopDomain: string,
): Promise<void> {
  const msg: InternalJobMessage = {
    id: newId('tiers-config'),
    topic: INTERNAL_PUBLISH_TIERS_CONFIG,
    shop_domain: shopDomain,
    body: '',
  };
  await env.WEBHOOK_QUEUE.send(msg);
}

/**
 * Enqueue a republish of `b2b.price_display`. Fire after the admin saves
 * settings that touch `priceDisplay`. The consumer reads the shop's current
 * settings and writes the Shop metafield the storefront overlay reads.
 */
export async function enqueuePriceDisplayPublish(
  env: Env,
  shopDomain: string,
): Promise<void> {
  const msg: InternalJobMessage = {
    id: newId('price-display'),
    topic: INTERNAL_PUBLISH_PRICE_DISPLAY,
    shop_domain: shopDomain,
    body: '',
  };
  await env.WEBHOOK_QUEUE.send(msg);
}

/**
 * Enqueue an application-state email. The queue handler reads the current
 * row + email template and calls Resend. Network failures fall through to
 * the queue's retry policy.
 */
export async function enqueueApplicationEmail(
  env: Env,
  shopDomain: string,
  applicationId: number,
  kind: ApplicationEmailKind,
): Promise<void> {
  const msg: InternalJobMessage = {
    id: newId(`app-email-${kind}`),
    topic: INTERNAL_SEND_APPLICATION_EMAIL,
    shop_domain: shopDomain,
    body: JSON.stringify({ application_id: applicationId, kind }),
  };
  await env.WEBHOOK_QUEUE.send(msg);
}

/**
 * Enqueue a Company-metafield write for the given company. Use tier_id=null
 * when a mapping is being removed (consumer writes 0 as the "no tier" sentinel).
 */
/**
 * Enqueue delivery of a `customers/data_request` export bundle. The handler
 * loads the row, runs the export, and emails the JSON to the shop owner.
 * Used by the GDPR sweep (`handlers/gdpr-sweep.ts`).
 */
export async function enqueueGdprDataExport(
  env: Env,
  shopDomain: string,
  gdprRequestId: string,
): Promise<void> {
  const msg: InternalJobMessage = {
    id: newId('gdpr-export'),
    topic: INTERNAL_SEND_GDPR_EXPORT,
    shop_domain: shopDomain,
    body: JSON.stringify({ gdpr_request_id: gdprRequestId }),
  };
  await env.WEBHOOK_QUEUE.send(msg);
}

export async function enqueueCompanyTierMirror(
  env: Env,
  shopDomain: string,
  shopifyCompanyId: string,
  tierId: number | null,
): Promise<void> {
  const msg: InternalJobMessage = {
    id: newId('mirror-company'),
    topic: INTERNAL_MIRROR_COMPANY_TIER,
    shop_domain: shopDomain,
    body: JSON.stringify({ shopify_company_id: shopifyCompanyId, tier_id: tierId }),
  };
  await env.WEBHOOK_QUEUE.send(msg);
}
