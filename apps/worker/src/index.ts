import { Hono } from 'hono';
import type { Env } from './types.js';
import { oauthRouter } from './routes/oauth.js';
import { webhooksRouter, handleWebhookQueue } from './routes/webhooks.js';

interface WebhookQueueMessage {
  id: string;
  topic: string;
  shop_domain: string;
  body: string;
}

const app = new Hono<{ Bindings: Env }>();

app.route('/auth', oauthRouter);
app.route('/webhooks', webhooksRouter);

app.get('/health', c => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<WebhookQueueMessage>, env: Env): Promise<void> {
    await handleWebhookQueue(batch, env);
  },
};
