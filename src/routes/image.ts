import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { resolveTableId } from '../teable';

// Proxies Teable attachment images through this worker's own origin.
//
// Teable's attachment "presignedUrl" carries a short-lived signed token (a few
// minutes) that's baked into the SPA's IndexedDB table cache, which only
// re-fetches on a table's lastModifiedTime change — so cached image URLs go
// stale long before the underlying data does, and <img> requests start
// 400ing with "Token has expired". This endpoint gives the SPA a stable URL
// (table + record + field) that never expires; on every hit it re-fetches the
// single record (public, unauthenticated on this Teable instance) for a fresh
// presignedUrl and streams the bytes back same-origin.
const TABLE_NAMES: Record<string, string> = {
  breeds: 'Breeds',
  chroma: 'Chroma Combinations',
  glass:  'Glass Combinations',
};

interface AttachmentEntry {
  presignedUrl?: string;
  mimetype?: string;
  name?: string;
}

export async function registerImageRoutes(app: FastifyInstance) {
  app.get<{ Params: { table: string; recordId: string; field: string } }>(
    '/api/image/:table/:recordId/:field',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { table, recordId, field } = req.params;
      const tableName = TABLE_NAMES[table];
      if (!tableName) return reply.code(404).send({ error: 'unknown table' });

      let tableId: string;
      try {
        tableId = await resolveTableId(tableName);
      } catch {
        return reply.code(502).send({ error: 'Could not reach the database. Please try again.' });
      }

      const recordUrl =
        `${config.teable.baseUrl}/api/table/${tableId}/record/${encodeURIComponent(recordId)}` +
        `?fieldKeyType=dbFieldName`;
      let recordRes: Response;
      try {
        recordRes = await fetch(recordUrl, { headers: { Accept: 'application/json' } });
      } catch {
        return reply.code(502).send({ error: 'Could not reach the database. Please try again.' });
      }
      if (recordRes.status === 404) return reply.code(404).send({ error: 'record not found' });
      if (!recordRes.ok) return reply.code(502).send({ error: 'Database lookup failed.' });

      const record = (await recordRes.json()) as { fields?: Record<string, unknown> };
      const fieldVal = record.fields?.[field];
      const entry = (Array.isArray(fieldVal) ? fieldVal[0] : undefined) as AttachmentEntry | undefined;
      if (!entry?.presignedUrl) return reply.code(404).send({ error: 'no attachment on this field' });

      let imgRes: Response;
      try {
        imgRes = await fetch(entry.presignedUrl);
      } catch {
        return reply.code(502).send({ error: 'Could not reach the database. Please try again.' });
      }
      if (!imgRes.ok || !imgRes.body) return reply.code(502).send({ error: 'Attachment fetch failed.' });

      const buf = Buffer.from(await imgRes.arrayBuffer());
      reply.header('Content-Type', entry.mimetype ?? imgRes.headers.get('content-type') ?? 'application/octet-stream');
      reply.header('Content-Disposition', `inline${entry.name ? `; filename="${entry.name}"` : ''}`);
      // The proxy URL itself is stable (keyed by record+field), so browsers can
      // cache the bytes — the underlying attachment rarely changes after upload.
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(buf);
    },
  );
}
