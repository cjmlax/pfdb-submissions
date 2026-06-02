import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { queries, uploadsDir } from '../db';
import { getHandler, listHandlers } from '../handlers/registry';

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function registerPublicRoutes(app: FastifyInstance) {
  // Advertises the accepted submission types (handy for the website / debugging).
  app.get('/api/types', async () =>
    listHandlers().map((h) => ({ type: h.type, label: h.label, acceptsScreenshot: !!h.acceptsScreenshot })),
  );

  // Public submission endpoint. Accepts multipart/form-data with fields:
  //   type     — handler key (e.g. "combo")
  //   payload  — JSON string validated by that handler's schema
  //   hp_url   — honeypot; real users leave it empty
  //   screenshot — optional image file
  app.post(
    '/api/submit',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      let typeStr = '';
      let payloadStr = '';
      let honeypot = '';
      let fileBuf: Buffer | null = null;
      let fileExt = '';

      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (part.fieldname === 'screenshot') {
              const ext = IMAGE_EXT[part.mimetype];
              const buf = await part.toBuffer();
              if (ext && buf.length > 0) {
                fileBuf = buf;
                fileExt = ext;
              }
            } else {
              await part.toBuffer(); // drain unexpected files
            }
          } else if (part.fieldname === 'type') {
            typeStr = String(part.value);
          } else if (part.fieldname === 'payload') {
            payloadStr = String(part.value);
          } else if (part.fieldname === 'hp_url') {
            honeypot = String(part.value);
          }
        }
      } catch (e) {
        if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(413).send({ error: 'screenshot too large' });
        }
        throw e;
      }

      // Honeypot tripped → pretend success and silently drop.
      if (honeypot.trim() !== '') return reply.send({ ok: true });

      const handler = getHandler(typeStr);
      if (!handler) return reply.code(400).send({ error: 'unknown submission type' });

      let payload: unknown;
      try {
        payload = JSON.parse(payloadStr || '{}');
      } catch {
        return reply.code(400).send({ error: 'invalid payload JSON' });
      }

      const parsed = handler.schema.safeParse(payload);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'validation failed', detail: parsed.error.flatten() });
      }

      const id = randomUUID();
      let screenshot: string | null = null;
      if (fileBuf && handler.acceptsScreenshot) {
        screenshot = `${id}.${fileExt}`;
        fs.writeFileSync(path.join(uploadsDir, screenshot), fileBuf);
      }

      // Surface the attribution link (if any) in the review note column.
      const data = parsed.data as { sourceLink?: string };
      const ipHash = createHash('sha256')
        .update(`${req.ip}|${config.auth.cookieSecret}`)
        .digest('hex')
        .slice(0, 16);

      queries.insert.run({
        id,
        type: handler.type,
        payload: JSON.stringify(parsed.data),
        summary: handler.summarize(parsed.data),
        screenshot,
        submitter_note: data.sourceLink ?? null,
        source_ip: ipHash,
        created_at: new Date().toISOString(),
      });

      req.log.info({ id, type: handler.type }, 'submission received');
      return reply.send({ ok: true, id });
    },
  );
}
