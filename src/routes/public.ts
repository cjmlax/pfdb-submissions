import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { queries, uploadsDir } from '../db';
import { getHandler, listHandlers } from '../handlers/registry';
import { notify } from '../notify';
import { broadcastSse } from '../sse';

// Tables exposed via the public export API. Slugs become URL path segments and
// CSV filenames, so keep them lowercase and URL-safe.
const EXPORT_TABLES: Record<string, { label: string; tableId: string }> = {
  frogs:  { label: 'Frogs',        tableId: config.teable.tables.frogs  },
  breeds: { label: 'Breeds',       tableId: config.teable.tables.breeds },
  chroma: { label: 'Chroma Combos', tableId: config.teable.tables.chroma },
  glass:  { label: 'Glass Combos',  tableId: config.teable.tables.glass  },
};

// In-memory record of when each table was last successfully exported.
// Resets on worker restart; good enough as a freshness hint for the UI.
const lastExported = new Map<string, string>();

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

      const summary = handler.summarize(parsed.data);
      const createdAt = new Date().toISOString();

      queries.insert.run({
        id,
        type: handler.type,
        payload: JSON.stringify(parsed.data),
        summary,
        screenshot,
        submitter_note: data.sourceLink ?? null,
        source_ip: ipHash,
        created_at: createdAt,
      });

      req.log.info({ id, type: handler.type }, 'submission received');
      notify('submission.created', { id, type: handler.type, summary, submitterNote: data.sourceLink, createdAt });
      broadcastSse('submission', { id, type: handler.type, summary });
      return reply.send({ ok: true, id });
    },
  );

  // Lists available export tables with their last-exported timestamps.
  app.get('/api/export', async () =>
    Object.entries(EXPORT_TABLES).map(([slug, { label }]) => ({
      slug,
      label,
      lastExported: lastExported.get(slug) ?? null,
    })),
  );

  // Streams a live CSV export from Teable for the requested table. Rate-limited
  // per IP to prevent hammering the database. Returns JSON errors on failure so
  // the client can always distinguish a bad response from a partial download.
  app.get<{ Params: { table: string } }>(
    '/api/export/:table',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const { table } = req.params;
      const entry = EXPORT_TABLES[table];
      if (!entry) return reply.code(404).send({ error: 'Unknown table' });

      if (!config.teable.token) {
        return reply.code(503).send({ error: 'Export unavailable' });
      }

      const exportUrl = `${config.teable.baseUrl}/api/table/${entry.tableId}/export`;
      let upstream: Response;
      try {
        upstream = await fetch(exportUrl, {
          headers: { Authorization: `Bearer ${config.teable.token}` },
        });
      } catch {
        req.log.warn({ table }, 'could not reach Teable for export');
        return reply.code(502).send({ error: 'Could not reach the database. Please try again.' });
      }

      if (!upstream.ok || !upstream.body) {
        req.log.warn({ table, status: upstream.status }, 'Teable export failed');
        return reply.code(502).send({ error: 'Export unavailable. Please try again later.' });
      }

      lastExported.set(table, new Date().toISOString());
      const date = new Date().toISOString().slice(0, 10);

      const bytes = await upstream.arrayBuffer();
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${table}-${date}.csv"`);
      reply.header('Cache-Control', 'no-store');
      return reply.send(Buffer.from(bytes));
    },
  );
}
