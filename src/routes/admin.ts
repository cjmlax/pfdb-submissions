import path from 'node:path';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { getById, listByStatus, queries, uploadsDir, type SubmissionRow } from '../db';
import { getHandler } from '../handlers/registry';
import type { AuthProvider } from '../auth';
import { renderAdminPage } from '../admin/page';
import { notify } from '../notify';
import { addSseClient, removeSseClient } from '../sse';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function toDto(r: SubmissionRow) {
  return {
    id: r.id,
    type: r.type,
    payload: r.payload,
    summary: r.summary,
    submitterNote: r.submitter_note,
    screenshot: r.screenshot ? `/api/admin/uploads/${r.screenshot}` : null,
    createdAt: r.created_at,
  };
}

export async function registerAdminRoutes(app: FastifyInstance, auth: AuthProvider) {
  // Everything in this scope is gated by the chosen auth provider.
  await app.register(async (admin) => {
    admin.addHook('preHandler', auth.requireAdmin);

    // Server-rendered review page.
    admin.get('/api/admin/', async (req, reply) => {
      const pending = listByStatus('pending');
      reply
        .type('text/html')
        .send(renderAdminPage(pending.map(toDto), req.adminUser?.username ?? 'admin', auth.logoutPath));
    });

    // JSON list (used by the CLI and any future custom UI).
    admin.get('/api/admin/pending', async () => listByStatus('pending').map(toDto));

    // Server-Sent Events stream — pushes 'submission' events to open review tabs.
    admin.get('/api/admin/events', (req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      addSseClient(res);

      const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
      }, 30_000);

      req.raw.on('close', () => {
        clearInterval(heartbeat);
        removeSseClient(res);
      });
    });

    // Serve an uploaded screenshot for review (admin-gated).
    admin.get('/api/admin/uploads/:file', async (req, reply) => {
      const file = (req.params as { file: string }).file;
      if (!/^[\w.-]+$/.test(file)) return reply.code(400).send('bad filename');
      const full = path.join(uploadsDir, file);
      if (!fs.existsSync(full)) return reply.code(404).send('not found');
      const ext = file.split('.').pop()?.toLowerCase() ?? '';
      return reply.type(MIME_BY_EXT[ext] ?? 'application/octet-stream').send(fs.createReadStream(full));
    });

    // Approve → push downstream → mark pushed (or error, with the message kept).
    admin.post('/api/admin/:id/approve', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const row = getById(id);
      if (!row) return reply.code(404).send({ error: 'not found' });
      if (row.status !== 'pending') return reply.code(409).send({ error: `already ${row.status}` });

      const handler = getHandler(row.type);
      if (!handler) return reply.code(500).send({ error: `no handler for type "${row.type}"` });

      try {
        const payload = JSON.parse(row.payload);
        const screenshotPath = row.screenshot ? path.join(uploadsDir, row.screenshot) : null;
        const ref = (await handler.pushDown(payload, { screenshotPath })) || null;
        queries.setStatus.run({
          id, status: 'pushed', reviewer_note: null, reviewed_at: new Date().toISOString(), pushed_ref: ref,
        });
        req.log.info({ id, ref }, 'submission pushed');
        notify('submission.approved', { id: row.id, type: row.type, summary: row.summary, submitterNote: row.submitter_note, createdAt: row.created_at });
        return { ok: true, pushed_ref: ref };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        queries.setStatus.run({
          id, status: 'error', reviewer_note: message, reviewed_at: new Date().toISOString(), pushed_ref: null,
        });
        req.log.error({ id, err: message }, 'push failed');
        return reply.code(502).send({ error: 'push failed', detail: message });
      }
    });

    // Edit → update payload and/or screenshot, leave status as pending.
    admin.patch('/api/admin/:id', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const row = getById(id);
      if (!row) return reply.code(404).send({ error: 'not found' });
      if (row.status !== 'pending') return reply.code(409).send({ error: `cannot edit: already ${row.status}` });

      const handler = getHandler(row.type);
      if (!handler) return reply.code(500).send({ error: `no handler for type "${row.type}"` });

      let payloadStr = '';
      let newFileBuf: Buffer | null = null;
      let newFileExt = '';
      let clearScreenshot = false;

      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname === 'screenshot') {
            const ext = IMAGE_EXT[part.mimetype];
            const buf = await part.toBuffer();
            if (ext && buf.length > 0) { newFileBuf = buf; newFileExt = ext; }
          } else {
            await part.toBuffer();
          }
        } else if (part.fieldname === 'payload') {
          payloadStr = String(part.value);
        } else if (part.fieldname === 'clearScreenshot') {
          clearScreenshot = String(part.value) === '1';
        }
      }

      let payload: unknown;
      try { payload = JSON.parse(payloadStr || '{}'); }
      catch { return reply.code(400).send({ error: 'invalid payload JSON' }); }

      const summary = handler.summarize(payload as never);

      let screenshot = row.screenshot;
      if (newFileBuf) {
        if (row.screenshot) {
          const oldPath = path.join(uploadsDir, row.screenshot);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        screenshot = `${id}.${newFileExt}`;
        fs.writeFileSync(path.join(uploadsDir, screenshot), newFileBuf);
      } else if (clearScreenshot && row.screenshot) {
        const oldPath = path.join(uploadsDir, row.screenshot);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        screenshot = null;
      }

      queries.update.run({ id, payload: JSON.stringify(payload), summary, screenshot });
      req.log.info({ id }, 'submission edited');
      return { ok: true, summary };
    });

    // Reject → mark rejected with an optional note.
    admin.post('/api/admin/:id/reject', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const row = getById(id);
      if (!row) return reply.code(404).send({ error: 'not found' });
      const note = (req.body as { note?: string } | undefined)?.note ?? null;
      queries.setStatus.run({
        id, status: 'rejected', reviewer_note: note, reviewed_at: new Date().toISOString(), pushed_ref: null,
      });
      notify('submission.rejected', { id, type: row.type, summary: row.summary, submitterNote: row.submitter_note, createdAt: row.created_at });
      return { ok: true };
    });
  });
}
