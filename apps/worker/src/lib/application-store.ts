/**
 * Wholesale application CRUD.
 *
 * The form payload (PII + custom fields + uploaded document references) is
 * AES-GCM encrypted with the per-shop HKDF subkey before being written to
 * `applications.form_data_encrypted`. Plaintext only exists in memory for
 * the duration of a single request.
 *
 * Statuses (from the 0001_init schema):
 *   draft → submitted → (approved | rejected | needs_info)
 *                       needs_info → submitted (after the buyer resubmits)
 *
 * Documents are kept inside the encrypted payload as
 *   { documents: [{ name, r2_key, size, mime }, ...] }
 * to avoid a separate table and per-document FK plumbing. R2 keys are
 * prefixed `shops/<shop_id>/applications/<aid>/...`.
 */

import { decrypt, encrypt } from './crypto.js';

export type ApplicationStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'needs_info';

export const APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'needs_info',
];

export interface ApplicationDocument {
  name: string;
  r2_key: string;
  size: number;
  mime: string;
}

export interface ApplicationFormData {
  /** Custom merchant-defined fields keyed by field id. */
  fields: Record<string, string>;
  /** Server-derived fields that are NOT part of the merchant form schema. */
  email: string;
  countryCode?: string;
  taxId?: string;
  gstNumber?: string;
  companyName?: string;
  documents: ApplicationDocument[];
}

export interface ApplicationRow {
  id: number;
  shop_id: number;
  email: string;
  status: ApplicationStatus;
  submitted_at: number | null;
  decided_at: number | null;
  decided_by: string | null;
  decision_notes: string | null;
  created_company_id: string | null;
  created_location_id: string | null;
  created_at: number | null;
  last_autosaved_at: number | null;
  shopify_customer_id: string | null;
}

export interface ApplicationDetail extends ApplicationRow {
  form: ApplicationFormData;
}

const EMPTY_FORM: ApplicationFormData = {
  fields: {},
  email: '',
  documents: [],
};

function rowToApplication(row: Record<string, unknown>): ApplicationRow {
  return {
    id: row.id as number,
    shop_id: row.shop_id as number,
    email: row.email as string,
    status: row.status as ApplicationStatus,
    submitted_at: (row.submitted_at as number | null) ?? null,
    decided_at: (row.decided_at as number | null) ?? null,
    decided_by: (row.decided_by as string | null) ?? null,
    decision_notes: (row.decision_notes as string | null) ?? null,
    created_company_id: (row.created_company_id as string | null) ?? null,
    created_location_id: (row.created_location_id as string | null) ?? null,
    created_at: (row.created_at as number | null) ?? null,
    last_autosaved_at: (row.last_autosaved_at as number | null) ?? null,
    shopify_customer_id: (row.shopify_customer_id as string | null) ?? null,
  };
}

export async function listApplications(
  db: D1Database,
  shopId: number,
  filter: { status?: ApplicationStatus } = {},
): Promise<ApplicationRow[]> {
  const params: unknown[] = [shopId];
  let where = `shop_id = ?`;
  if (filter.status) {
    where += ` AND status = ?`;
    params.push(filter.status);
  }
  const result = await db
    .prepare(
      `SELECT id, shop_id, email, status, submitted_at, decided_at, decided_by,
              decision_notes, created_company_id, created_location_id,
              created_at, last_autosaved_at, shopify_customer_id
       FROM applications
       WHERE ${where}
       ORDER BY COALESCE(submitted_at, last_autosaved_at, created_at, 0) DESC`,
    )
    .bind(...params)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(rowToApplication);
}

export async function getApplicationRow(
  db: D1Database,
  shopId: number,
  applicationId: number,
): Promise<ApplicationRow | null> {
  const row = await db
    .prepare(
      `SELECT id, shop_id, email, status, submitted_at, decided_at, decided_by,
              decision_notes, created_company_id, created_location_id,
              created_at, last_autosaved_at, shopify_customer_id
       FROM applications
       WHERE shop_id = ? AND id = ?`,
    )
    .bind(shopId, applicationId)
    .first<Record<string, unknown>>();
  return row ? rowToApplication(row) : null;
}

export async function getApplicationDetail(
  db: D1Database,
  shopId: number,
  applicationId: number,
  shopDomain: string,
  masterKeyHex: string,
): Promise<ApplicationDetail | null> {
  const row = await db
    .prepare(
      `SELECT id, shop_id, email, status, submitted_at, decided_at, decided_by,
              decision_notes, created_company_id, created_location_id,
              created_at, last_autosaved_at, shopify_customer_id,
              form_data_encrypted
       FROM applications
       WHERE shop_id = ? AND id = ?`,
    )
    .bind(shopId, applicationId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const base = rowToApplication(row);
  const blob = row.form_data_encrypted as string | null;
  const form = blob ? await decryptForm(blob, shopDomain, masterKeyHex) : EMPTY_FORM;
  return { ...base, form };
}

export async function decryptForm(
  encryptedB64: string,
  shopDomain: string,
  masterKeyHex: string,
): Promise<ApplicationFormData> {
  try {
    const plaintext = await decrypt(encryptedB64, shopDomain, masterKeyHex);
    const parsed = JSON.parse(plaintext) as Partial<ApplicationFormData>;
    return {
      fields: parsed.fields ?? {},
      email: parsed.email ?? '',
      countryCode: parsed.countryCode,
      taxId: parsed.taxId,
      gstNumber: parsed.gstNumber,
      companyName: parsed.companyName,
      documents: parsed.documents ?? [],
    };
  } catch {
    return EMPTY_FORM;
  }
}

export interface CreateOrUpdateDraftInput {
  email: string;
  form: ApplicationFormData;
}

export interface DraftResult {
  id: number;
  created: boolean;
}

/**
 * Idempotent draft upsert keyed on (shop_id, email) among non-terminal rows.
 * The 0001 schema's partial unique index
 * `idx_apps_pending_email (shop_id, email) WHERE status IN ('draft','submitted','needs_info')`
 * keeps us from creating two live drafts for the same email.
 */
export async function upsertDraft(
  db: D1Database,
  shopId: number,
  shopDomain: string,
  masterKeyHex: string,
  input: CreateOrUpdateDraftInput,
): Promise<DraftResult> {
  const email = input.email.trim().toLowerCase();
  const existing = await db
    .prepare(
      `SELECT id, status FROM applications
       WHERE shop_id = ? AND email = ? AND status IN ('draft', 'needs_info')`,
    )
    .bind(shopId, email)
    .first<{ id: number; status: ApplicationStatus }>();

  const now = Math.floor(Date.now() / 1000);
  const blob = await encryptForm({ ...input.form, email }, shopDomain, masterKeyHex);

  if (existing) {
    await db
      .prepare(
        `UPDATE applications
         SET form_data_encrypted = ?, last_autosaved_at = ?
         WHERE shop_id = ? AND id = ?`,
      )
      .bind(blob, now, shopId, existing.id)
      .run();
    return { id: existing.id, created: false };
  }

  const result = await db
    .prepare(
      `INSERT INTO applications
         (shop_id, email, status, form_data_encrypted, created_at, last_autosaved_at)
       VALUES (?, ?, 'draft', ?, ?, ?)
       RETURNING id`,
    )
    .bind(shopId, email, blob, now, now)
    .first<{ id: number }>();
  if (!result) throw new Error('upsertDraft: no id returned');
  return { id: result.id, created: true };
}

export async function encryptForm(
  form: ApplicationFormData,
  shopDomain: string,
  masterKeyHex: string,
): Promise<string> {
  return encrypt(JSON.stringify(form), shopDomain, masterKeyHex);
}

export class ApplicationStateError extends Error {}

export async function submitApplication(
  db: D1Database,
  shopId: number,
  applicationId: number,
  shopDomain: string,
  masterKeyHex: string,
  form: ApplicationFormData,
): Promise<ApplicationRow> {
  const row = await getApplicationRow(db, shopId, applicationId);
  if (!row) throw new ApplicationStateError('application not found');
  if (row.status !== 'draft' && row.status !== 'needs_info') {
    throw new ApplicationStateError(`cannot submit from status=${row.status}`);
  }
  const blob = await encryptForm(form, shopDomain, masterKeyHex);
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE applications
       SET status = 'submitted', form_data_encrypted = ?, submitted_at = ?
       WHERE shop_id = ? AND id = ?`,
    )
    .bind(blob, now, shopId, applicationId)
    .run();
  const updated = await getApplicationRow(db, shopId, applicationId);
  if (!updated) throw new Error('submitApplication: row vanished after update');
  return updated;
}

export interface DecisionInput {
  status: 'approved' | 'rejected' | 'needs_info';
  decidedBy: string;
  notes?: string | null;
  companyId?: string | null;
  locationId?: string | null;
  customerId?: string | null;
}

/**
 * Apply a decision idempotently. Re-applying the same decision is a no-op
 * (no row updates, no state churn). Re-applying a *different* decision
 * throws — the caller must explicitly re-open the application first.
 */
export async function recordDecision(
  db: D1Database,
  shopId: number,
  applicationId: number,
  input: DecisionInput,
): Promise<{ row: ApplicationRow; alreadyApplied: boolean }> {
  const row = await getApplicationRow(db, shopId, applicationId);
  if (!row) throw new ApplicationStateError('application not found');

  if (row.status === input.status) {
    // Idempotent re-apply: same operator, same notes → no-op; different
    // operator or notes → just refresh the audit fields.
    const now = Math.floor(Date.now() / 1000);
    const sameOperator = row.decided_by === input.decidedBy;
    const sameNotes = (row.decision_notes ?? null) === (input.notes ?? null);
    if (sameOperator && sameNotes) {
      return { row, alreadyApplied: true };
    }
    await db
      .prepare(
        `UPDATE applications
         SET decided_at = ?, decided_by = ?, decision_notes = ?
         WHERE shop_id = ? AND id = ?`,
      )
      .bind(now, input.decidedBy, input.notes ?? null, shopId, applicationId)
      .run();
    const refreshed = await getApplicationRow(db, shopId, applicationId);
    if (!refreshed) throw new Error('recordDecision: row vanished');
    return { row: refreshed, alreadyApplied: true };
  }

  if (row.status === 'approved' || row.status === 'rejected') {
    throw new ApplicationStateError(
      `cannot move from terminal status=${row.status} to ${input.status}`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE applications
       SET status = ?, decided_at = ?, decided_by = ?, decision_notes = ?,
           created_company_id = COALESCE(?, created_company_id),
           created_location_id = COALESCE(?, created_location_id),
           shopify_customer_id = COALESCE(?, shopify_customer_id)
       WHERE shop_id = ? AND id = ?`,
    )
    .bind(
      input.status,
      now,
      input.decidedBy,
      input.notes ?? null,
      input.companyId ?? null,
      input.locationId ?? null,
      input.customerId ?? null,
      shopId,
      applicationId,
    )
    .run();
  const updated = await getApplicationRow(db, shopId, applicationId);
  if (!updated) throw new Error('recordDecision: row vanished');
  return { row: updated, alreadyApplied: false };
}
