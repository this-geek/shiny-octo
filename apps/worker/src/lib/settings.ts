/**
 * Admin settings stored in `shops.settings_json`.
 *
 * The column is a free-form JSON blob shared with other features
 * (e.g. `app_proxy.subpath` per DECISIONS #9), so writes shallow-merge
 * at the top level: only keys present in the incoming payload are
 * replaced; unrelated keys are preserved.
 */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const FIELD_TYPES = ['text', 'email', 'tel', 'textarea', 'select', 'file'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const FIELD_ID = /^[a-z][a-z0-9_]{0,39}$/;

const MAX_FIELDS = 50;
const MAX_SUBJECT = 200;
const MAX_BODY = 10000;

export interface BrandSettings {
  primaryColor?: string;
  accentColor?: string;
}

export interface ApplicationFormField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

export interface ApplicationFormSettings {
  fields: ApplicationFormField[];
  requireDocuments: boolean;
}

export interface EmailTemplate {
  subject: string;
  body: string;
}

export interface EmailTemplates {
  approved?: EmailTemplate;
  rejected?: EmailTemplate;
  moreInfo?: EmailTemplate;
}

export interface AdminSettings {
  brand?: BrandSettings;
  applicationForm?: ApplicationFormSettings;
  emailTemplates?: EmailTemplates;
}

export type SettingsBlob = AdminSettings & Record<string, unknown>;

export class SettingsValidationError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateBrand(input: unknown): BrandSettings {
  if (!isObject(input)) throw new SettingsValidationError('brand must be an object');
  const out: BrandSettings = {};
  if (input.primaryColor !== undefined) {
    if (typeof input.primaryColor !== 'string' || !HEX_COLOR.test(input.primaryColor)) {
      throw new SettingsValidationError('brand.primaryColor must be #rrggbb');
    }
    out.primaryColor = input.primaryColor;
  }
  if (input.accentColor !== undefined) {
    if (typeof input.accentColor !== 'string' || !HEX_COLOR.test(input.accentColor)) {
      throw new SettingsValidationError('brand.accentColor must be #rrggbb');
    }
    out.accentColor = input.accentColor;
  }
  return out;
}

function validateField(input: unknown, index: number): ApplicationFormField {
  if (!isObject(input)) {
    throw new SettingsValidationError(`applicationForm.fields[${index}] must be an object`);
  }
  const { id, label, type, required, options } = input;
  if (typeof id !== 'string' || !FIELD_ID.test(id)) {
    throw new SettingsValidationError(
      `applicationForm.fields[${index}].id must match ^[a-z][a-z0-9_]{0,39}$`,
    );
  }
  if (typeof label !== 'string' || label.length === 0 || label.length > 200) {
    throw new SettingsValidationError(
      `applicationForm.fields[${index}].label must be 1-200 chars`,
    );
  }
  if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
    throw new SettingsValidationError(
      `applicationForm.fields[${index}].type must be one of ${FIELD_TYPES.join(', ')}`,
    );
  }
  if (typeof required !== 'boolean') {
    throw new SettingsValidationError(
      `applicationForm.fields[${index}].required must be boolean`,
    );
  }
  const field: ApplicationFormField = { id, label, type: type as FieldType, required };
  if (type === 'select') {
    if (!Array.isArray(options) || options.length === 0) {
      throw new SettingsValidationError(
        `applicationForm.fields[${index}].options required for select`,
      );
    }
    if (options.length > 50) {
      throw new SettingsValidationError(
        `applicationForm.fields[${index}].options max 50 entries`,
      );
    }
    const opts: string[] = [];
    for (const o of options) {
      if (typeof o !== 'string' || o.length === 0 || o.length > 200) {
        throw new SettingsValidationError(
          `applicationForm.fields[${index}].options entries must be 1-200 chars`,
        );
      }
      opts.push(o);
    }
    field.options = opts;
  }
  return field;
}

function validateApplicationForm(input: unknown): ApplicationFormSettings {
  if (!isObject(input)) {
    throw new SettingsValidationError('applicationForm must be an object');
  }
  const { fields, requireDocuments } = input;
  if (!Array.isArray(fields)) {
    throw new SettingsValidationError('applicationForm.fields must be an array');
  }
  if (fields.length > MAX_FIELDS) {
    throw new SettingsValidationError(`applicationForm.fields max ${MAX_FIELDS} entries`);
  }
  const seen = new Set<string>();
  const out: ApplicationFormField[] = [];
  fields.forEach((f, i) => {
    const validated = validateField(f, i);
    if (seen.has(validated.id)) {
      throw new SettingsValidationError(
        `applicationForm.fields[${i}].id "${validated.id}" duplicated`,
      );
    }
    seen.add(validated.id);
    out.push(validated);
  });
  if (typeof requireDocuments !== 'boolean') {
    throw new SettingsValidationError('applicationForm.requireDocuments must be boolean');
  }
  return { fields: out, requireDocuments };
}

function validateTemplate(input: unknown, name: string): EmailTemplate {
  if (!isObject(input)) {
    throw new SettingsValidationError(`emailTemplates.${name} must be an object`);
  }
  const { subject, body } = input;
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > MAX_SUBJECT) {
    throw new SettingsValidationError(
      `emailTemplates.${name}.subject must be 1-${MAX_SUBJECT} chars`,
    );
  }
  if (typeof body !== 'string' || body.length === 0 || body.length > MAX_BODY) {
    throw new SettingsValidationError(
      `emailTemplates.${name}.body must be 1-${MAX_BODY} chars`,
    );
  }
  return { subject, body };
}

function validateEmailTemplates(input: unknown): EmailTemplates {
  if (!isObject(input)) {
    throw new SettingsValidationError('emailTemplates must be an object');
  }
  const out: EmailTemplates = {};
  if (input.approved !== undefined) out.approved = validateTemplate(input.approved, 'approved');
  if (input.rejected !== undefined) out.rejected = validateTemplate(input.rejected, 'rejected');
  if (input.moreInfo !== undefined) out.moreInfo = validateTemplate(input.moreInfo, 'moreInfo');
  return out;
}

export function validateAdminSettingsPatch(input: unknown): AdminSettings {
  if (!isObject(input)) {
    throw new SettingsValidationError('payload must be an object');
  }
  const out: AdminSettings = {};
  if (input.brand !== undefined) out.brand = validateBrand(input.brand);
  if (input.applicationForm !== undefined) {
    out.applicationForm = validateApplicationForm(input.applicationForm);
  }
  if (input.emailTemplates !== undefined) {
    out.emailTemplates = validateEmailTemplates(input.emailTemplates);
  }
  return out;
}

export function parseSettingsBlob(raw: string | null | undefined): SettingsBlob {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? (parsed as SettingsBlob) : {};
  } catch {
    return {};
  }
}

export function mergeSettings(current: SettingsBlob, patch: AdminSettings): SettingsBlob {
  return { ...current, ...patch };
}

export function pickAdminSettings(blob: SettingsBlob): AdminSettings {
  const { brand, applicationForm, emailTemplates } = blob as AdminSettings;
  const out: AdminSettings = {};
  if (brand !== undefined) out.brand = brand;
  if (applicationForm !== undefined) out.applicationForm = applicationForm;
  if (emailTemplates !== undefined) out.emailTemplates = emailTemplates;
  return out;
}
