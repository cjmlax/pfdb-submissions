import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { getById, queries, uploadsDir } from '../db';
import { getHandler } from '../handlers/registry';
import { notify } from '../notify';

export async function registerActionRoutes(app: FastifyInstance) {
  if (!config.notify.actionSecret) return;

  function checkToken(token: string): boolean {
    return token === config.notify.actionSecret;
  }

  // Allow cross-origin requests from ntfy (token in URL provides auth).
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
  });
  app.options('/api/action/*', async (_req, reply) => {
    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'POST')
      .header('Access-Control-Allow-Headers', 'Content-Type')
      .code(204)
      .send();
  });

  app.post<{ Params: { token: string; id: string } }>('/api/action/:token/:id/approve', async (req, reply) => {
    if (!checkToken(req.params.token)) return reply.code(401).send({ error: 'unauthorized' });

    const row = getById(req.params.id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.status !== 'pending') return reply.code(409).send({ error: `already ${row.status}` });

    const handler = getHandler(row.type);
    if (!handler) return reply.code(500).send({ error: `no handler for type "${row.type}"` });

    try {
      const payload = JSON.parse(row.payload);
      const screenshotPath = row.screenshot ? path.join(uploadsDir, row.screenshot) : null;
      const ref = (await handler.pushDown(payload, { screenshotPath })) || null;
      queries.setStatus.run({ id: row.id, status: 'pushed', reviewer_note: null, reviewed_at: new Date().toISOString(), pushed_ref: ref });
      req.log.info({ id: row.id, ref }, 'action: submission approved');
      notify('submission.approved', { id: row.id, type: row.type, summary: row.summary, submitterNote: row.submitter_note, createdAt: row.created_at });
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      queries.setStatus.run({ id: row.id, status: 'error', reviewer_note: message, reviewed_at: new Date().toISOString(), pushed_ref: null });
      req.log.error({ id: row.id, err: message }, 'action: push failed');
      return reply.code(502).send({ error: 'push failed', detail: message });
    }
  });

  app.post<{ Params: { token: string; id: string } }>('/api/action/:token/:id/reject', async (req, reply) => {
    if (!checkToken(req.params.token)) return reply.code(401).send({ error: 'unauthorized' });

    const row = getById(req.params.id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.status !== 'pending') return reply.code(409).send({ error: `already ${row.status}` });

    queries.setStatus.run({ id: row.id, status: 'rejected', reviewer_note: null, reviewed_at: new Date().toISOString(), pushed_ref: null });
    req.log.info({ id: row.id }, 'action: submission rejected');
    notify('submission.rejected', { id: row.id, type: row.type, summary: row.summary, submitterNote: row.submitter_note, createdAt: row.created_at });
    return { ok: true };
  });
}
