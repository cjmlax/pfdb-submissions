import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { schedule as cronSchedule } from 'node-cron';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config';
import { queries, uploadsDir, listBySubmitter } from '../db';
import { resolveTableId } from '../teable';
import { requireUser, optionalUser } from '../userAuth';
import { upsertUser, setFlairPending, getProfile } from '../users';
import { getHandler, listHandlers } from '../handlers/registry';
import { notify } from '../notify';
import { broadcastSse } from '../sse';
import { compressImage } from '../imageProcess';

// Tables exposed via the public export API. Slugs become URL path segments and
// CSV filenames, so keep them lowercase and URL-safe. Table IDs are resolved by
// the Teable display name at request time (cached), not configured.
const EXPORT_TABLES: Record<string, { label: string; tableName: string }> = {
  frogs:  { label: 'Frogs',         tableName: 'Froggies' },
  breeds: { label: 'Breeds',        tableName: 'Breeds' },
  chroma: { label: 'Chroma Combos', tableName: 'Chroma Combinations' },
  glass:  { label: 'Glass Combos',  tableName: 'Glass Combinations' },
  weekly: { label: 'Weekly Sets',   tableName: 'Weekly Sets' },
};

// Persistent export state: hash + timestamp for each table, survives restarts.
interface ExportEntry { hash: string; exportedAt: string }
const STATE_FILE = path.join(config.dataDir, 'export-state.json');

function loadState(): Map<string, ExportEntry> {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const obj = JSON.parse(raw) as Record<string, ExportEntry>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveState(state: Map<string, ExportEntry>): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(state), null, 2));
  } catch { /* non-fatal — state remains correct in memory until next restart */ }
}

const exportState = loadState();

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

  // The signed-in user's own profile. Records/refreshes the user on every call
  // (so the directory builds itself as people sign in) and returns their badges.
  app.get('/api/me', { preHandler: requireUser }, async (req) => {
    const { sub, username } = req.user!;
    upsertUser(sub, username);
    return getProfile(sub);
  });

  // Lets a user submit their in-game Friend Code as flair. It is held PENDING and
  // does not go live until an admin approves it (after an off-line confirmation).
  // An empty value withdraws a pending request. Capped and trimmed.
  app.patch<{ Body: { flair?: string | null } }>(
    '/api/me',
    { preHandler: requireUser },
    async (req) => {
      const { sub, username } = req.user!;
      upsertUser(sub, username);
      const raw = typeof req.body?.flair === 'string' ? req.body.flair.trim().slice(0, 80) : '';
      setFlairPending(sub, raw || null);
      if (raw) {
        notify('flair.requested', {
          id: sub,
          type: 'flair',
          summary: `Friend code: ${raw} — from ${username ?? sub}`,
          createdAt: new Date().toISOString(),
        });
      }
      return getProfile(sub);
    },
  );

  // The signed-in user's own submission history, newest first, with statuses.
  app.get('/api/me/submissions', { preHandler: requireUser }, async (req) =>
    listBySubmitter(req.user!.sub).map(r => ({
      id: r.id,
      type: r.type,
      summary: r.summary,
      status: r.status,
      reviewerNote: r.reviewer_note,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
    })),
  );

  // Public submission endpoint. Accepts multipart/form-data with fields:
  //   type     — handler key (e.g. "combo")
  //   payload  — JSON string validated by that handler's schema
  //   hp_url   — honeypot; real users leave it empty
  //   screenshot — optional image file
  app.post(
    '/api/submit',
    { preHandler: optionalUser, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      let typeStr = '';
      let payloadStr = '';
      let honeypot = '';
      let fileBuf: Buffer | null = null;

      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (part.fieldname === 'screenshot') {
              const ext = IMAGE_EXT[part.mimetype];
              const buf = await part.toBuffer();
              if (ext && buf.length > 0) {
                fileBuf = buf;
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

      if (handler.preSubmit) {
        try {
          await handler.preSubmit(parsed.data);
        } catch (e) {
          return reply.code(409).send({ error: e instanceof Error ? e.message : 'Submission not allowed.' });
        }
      }

      const id = randomUUID();
      let screenshot: string | null = null;
      if (fileBuf && handler.acceptsScreenshot) {
        const compressed = await compressImage(fileBuf);
        screenshot = `${id}.${compressed.ext}`;
        fs.writeFileSync(path.join(uploadsDir, screenshot), compressed.data);
      }

      // Surface the attribution link (if any) in the review note column.
      const data = parsed.data as { sourceLink?: string };
      const ipHash = createHash('sha256')
        .update(`${req.ip}|${config.ipHashSecret}`)
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
        submitter_sub: req.user?.sub ?? null,
        submitter_name: req.user?.username ?? null,
        source_ip: ipHash,
        created_at: createdAt,
      });

      // Also record the user in the directory so the admin can badge them later.
      if (req.user) upsertUser(req.user.sub, req.user.username);

      req.log.info({ id, type: handler.type, submitter: req.user?.username ?? null }, 'submission received');
      notify('submission.created', { id, type: handler.type, summary, submitterNote: data.sourceLink, createdAt });
      broadcastSse('submission', { id, type: handler.type, summary });
      return reply.send({ ok: true, id });
    },
  );

  // Fetches every export table, computes its hash, and persists the result.
  // Runs once shortly after startup and then every 24 hours.
  async function refreshHashes() {
    app.log.info('export hash refresh started');
    for (const [slug, { tableName }] of Object.entries(EXPORT_TABLES)) {
      try {
        const tableId = await resolveTableId(tableName);
        const res = await fetch(`${config.teable.baseUrl}/api/export/${tableId}`, {
          headers: { Authorization: `Bearer ${config.teable.token}` },
        });
        if (!res.ok) {
          app.log.warn({ slug, status: res.status }, 'hash refresh: Teable export failed');
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const hash = createHash('sha256').update(buf).digest('hex').slice(0, 8);
        exportState.set(slug, { hash, exportedAt: new Date().toISOString() });
      } catch (err) {
        app.log.warn({ slug, err }, 'hash refresh: fetch failed');
      }
    }
    saveState(exportState);
    app.log.info('export hash refresh complete');
  }

  setTimeout(refreshHashes, 10_000); // run once after startup settles
  cronSchedule(config.export.hashRefreshCron, refreshHashes);

  // Lists available export tables with their persisted hash and timestamp.
  app.get('/api/export', async () =>
    Object.entries(EXPORT_TABLES).map(([slug, { label }]) => {
      const entry = exportState.get(slug);
      return { slug, label, hash: entry?.hash ?? null, exportedAt: entry?.exportedAt ?? null };
    }),
  );

  // Triggers a server-side hash refresh for all tables and returns the updated list.
  // Rate-limited aggressively since each call fetches all tables from Teable.
  app.post(
    '/api/export/refresh',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (_req, reply) => {
      if (!config.teable.token) {
        return reply.code(503).send({ error: 'Export unavailable' });
      }
      await refreshHashes();
      return Object.entries(EXPORT_TABLES).map(([slug, { label }]) => {
        const entry = exportState.get(slug);
        return { slug, label, hash: entry?.hash ?? null, exportedAt: entry?.exportedAt ?? null };
      });
    },
  );

  // Fetches a CSV from Teable, updates the cached hash, and sends it to the client.
  async function serveExportCsv(
    table: string,
    entry: { label: string; tableName: string },
    req: FastifyRequest,
    reply: FastifyReply,
  ) {
    if (!config.teable.token) {
      return reply.code(503).send({ error: 'Export unavailable' });
    }

    const exportUrl = `${config.teable.baseUrl}/api/export/${await resolveTableId(entry.tableName)}`;
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

    const bytes = await upstream.arrayBuffer();
    const buf = Buffer.from(bytes);
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 8);
    const exportedAt = new Date().toISOString();
    exportState.set(table, { hash, exportedAt });
    saveState(exportState);

    const date = exportedAt.slice(0, 10);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${table}-${date}-${hash}.csv"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(buf);
  }

  // Redirects to the versioned URL so the filename is visible in the URL path.
  // Browsers save using the last path segment; fetch() clients can read response.url
  // to get the filename without needing Content-Disposition exposed via CORS.
  // Falls back to serving directly if no hash is cached yet (first boot).
  app.get<{ Params: { table: string } }>(
    '/api/export/:table',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const { table } = req.params;
      const entry = EXPORT_TABLES[table];
      if (!entry) return reply.code(404).send({ error: 'Unknown table' });

      const state = exportState.get(table);
      if (state) {
        const date = state.exportedAt.slice(0, 10);
        return reply.redirect(`/api/export/${table}/${table}-${date}-${state.hash}.csv`);
      }
      return serveExportCsv(table, entry, req, reply);
    },
  );

  // Actual download — :filename is purely a hint for the browser's save dialog.
  app.get<{ Params: { table: string; filename: string } }>(
    '/api/export/:table/:filename',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const { table } = req.params;
      const entry = EXPORT_TABLES[table];
      if (!entry) return reply.code(404).send({ error: 'Unknown table' });
      return serveExportCsv(table, entry, req, reply);
    },
  );
}
