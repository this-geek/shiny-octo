/**
 * Thin wrapper over the Resend API (DECISIONS #16 Q5).
 *
 * One function, one purpose: send a transactional email.
 *
 *   - 401/403 from Resend → throw RecognisedSendError (caller should NOT retry)
 *   - 4xx other than auth → throw RecognisedSendError (don't retry)
 *   - 5xx / network → throw RetryableSendError (queue will retry)
 *
 * https://resend.com/docs/api-reference/emails/send-email
 */

const API_URL = 'https://api.resend.com/emails';

export class RecognisedSendError extends Error {
  constructor(public status: number, public body: string) {
    super(`Resend error ${status}: ${body.slice(0, 200)}`);
  }
}

export class RetryableSendError extends Error {
  constructor(public status: number | null, public detail: string) {
    super(`Resend retryable error (${status ?? 'network'}): ${detail.slice(0, 200)}`);
  }
}

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export async function sendEmail(
  apiKey: string | undefined,
  input: SendEmailInput,
): Promise<{ id: string }> {
  if (!apiKey) {
    // In dev / unconfigured environments we throw a recognised error rather
    // than silently swallowing the call. Callers gate on email-templates being
    // configured before invoking this anyway.
    throw new RecognisedSendError(0, 'RESEND_API_KEY is not configured');
  }

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        reply_to: input.replyTo,
      }),
    });
  } catch (err) {
    throw new RetryableSendError(null, String(err));
  }

  const bodyText = await res.text();
  if (res.ok) {
    try {
      const json = JSON.parse(bodyText) as { id?: string };
      return { id: json.id ?? '' };
    } catch {
      return { id: '' };
    }
  }
  if (res.status >= 500) throw new RetryableSendError(res.status, bodyText);
  throw new RecognisedSendError(res.status, bodyText);
}

/**
 * Minimal mustache-style template render. Supports {{name}} and HTML-escapes
 * variable values to prevent injection through merchant-edited templates.
 * Whitespace inside {{...}} is tolerated.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) return '';
    return escapeHtml(value);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
