import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const form = await request.formData();
  const workerBase = form.get('workerBase')?.toString() ?? '';
  const idToken = form.get('idToken')?.toString() ?? '';

  if (!workerBase || !idToken) {
    return json({ ok: false, error: 'missing workerBase or idToken' }, { status: 400 });
  }

  const res = await fetch(`${workerBase}/admin/plus-banner/dismiss`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
  });

  if (!res.ok) return json({ ok: false, error: `worker ${res.status}` }, { status: 502 });
  return json({ ok: true });
}
