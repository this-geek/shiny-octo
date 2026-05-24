/**
 * Cloudflare Turnstile siteverify wrapper.
 *
 * Gating: if TURNSTILE_SECRET_KEY is unset (e.g. in dev, or for a merchant
 * who hasn't opted in), `verifyTurnstile` returns { ok: true, skipped: true }
 * and the caller MUST log that it was skipped. We never silently treat
 * absence-of-secret as "captcha passed" in user-facing flows; the buyer-side
 * code reads a public `turnstileEnabled` flag from the form-config endpoint
 * so it knows whether to render the widget at all.
 *
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

interface SiteverifyResponse {
  success?: boolean;
  'error-codes'?: string[];
  hostname?: string;
  challenge_ts?: string;
}

export interface TurnstileResult {
  ok: boolean;
  skipped: boolean;
  errorCodes: string[];
}

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  secret: string | undefined,
  token: string | null | undefined,
  remoteIp: string | null = null,
): Promise<TurnstileResult> {
  if (!secret) return { ok: true, skipped: true, errorCodes: [] };
  if (!token) return { ok: false, skipped: false, errorCodes: ['missing-input-response'] };

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (remoteIp) body.set('remoteip', remoteIp);

  let res: Response;
  try {
    res = await fetch(VERIFY_URL, { method: 'POST', body });
  } catch (err) {
    return { ok: false, skipped: false, errorCodes: [`fetch-failed: ${String(err)}`] };
  }
  if (!res.ok) {
    return { ok: false, skipped: false, errorCodes: [`http-${res.status}`] };
  }

  let json: SiteverifyResponse;
  try {
    json = (await res.json()) as SiteverifyResponse;
  } catch {
    return { ok: false, skipped: false, errorCodes: ['bad-json'] };
  }

  return {
    ok: json.success === true,
    skipped: false,
    errorCodes: json['error-codes'] ?? [],
  };
}
