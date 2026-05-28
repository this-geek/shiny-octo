import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';

export async function action({ request, context }: ActionFunctionArgs): Promise<Response> {
  const form = await request.formData();
  const idToken = form.get('idToken')?.toString() ?? '';

  if (!idToken) {
    return json({ ok: false, error: 'missing idToken' }, { status: 400 });
  }

  const env = (context as { cloudflare?: { env?: Record<string, string> } }).cloudflare?.env ?? {};
  const workerBase = env.WORKER_URL ?? env.APP_URL ?? '';
  if (!workerBase) {
    return json({ ok: false, error: 'worker url not configured' }, { status: 500 });
  }

  const res = await fetch(`${workerBase}/admin/plus-banner/dismiss`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
  });

  if (!res.ok) return json({ ok: false, error: `worker ${res.status}` }, { status: 502 });
  return json({ ok: true });
}
