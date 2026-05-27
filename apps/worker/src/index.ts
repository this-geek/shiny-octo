import { Hono } from 'hono';
import type { Env } from './types.js';
import { oauthRouter } from './routes/oauth.js';
import { webhooksRouter, handleWebhookQueue } from './routes/webhooks.js';
import { adminRouter } from './routes/admin.js';
import { appProxyRouter } from './routes/app-proxy.js';
import { runActivationNudgesScan } from './handlers/activation-nudges.js';
import { runGdprSweep } from './handlers/gdpr-sweep.js';
import { log } from './lib/logger.js';

interface WebhookQueueMessage {
  id: string;
  topic: string;
  shop_domain: string;
  body: string;
}

const app = new Hono<{ Bindings: Env }>();

app.route('/auth', oauthRouter);
app.route('/webhooks', webhooksRouter);
app.route('/admin', adminRouter);
app.route('/proxy', appProxyRouter);

app.get('/health', c => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<WebhookQueueMessage>, env: Env): Promise<void> {
    await handleWebhookQueue(batch, env);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      Promise.allSettled([
        runActivationNudgesScan(env).catch(err => {
          log('error', 'scheduled: activation-nudges scan failed', {
            cron: event.cron,
            error: String(err),
          });
        }),
        runGdprSweep(env).catch(err => {
          log('error', 'scheduled: gdpr sweep failed', {
            cron: event.cron,
            error: String(err),
          });
        }),
      ]),
    );
  },
};
