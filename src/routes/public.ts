import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { schedule as cronSchedule } from 'node-cron';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config';
import { db, queries, uploadsDir, listBySubmitter, pendingPayloadValues } from '../db';
import { resolveTableId } from '../teable';
import { mapLimit } from '../async';
import { requireUser, optionalUser } from '../userAuth';
import {
  upsertUser, submitFlairRequest, clearFlairRequest, clearFlair, confirmFlairCode, getProfile, getUser,
  markWeeklyCompleted, clearWeeklyCompleted, completedWeeklySetIds,
} from '../users';
import { listActiveAlerts } from '../alerts';
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
  pairs:     { label: 'Frog Pairs', tableName: 'Frog Pairs' },
  mutations: { label: 'Mutations',  tableName: 'Mutations' },
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

// Most items one batch submit may carry. Sized to comfortably cover every frog
// currently missing stats, while bounding the Teable lookups one request makes.
const MAX_BATCH = 500;

function hashIp(ip: string): string {
  return createHash('sha256').update(`${ip}|${config.ipHashSecret}`).digest('hex').slice(0, 16);
}

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

  // Active site-wide announcement banners, newest first. Public — no auth, so
  // the SPA can show maintenance/outage notices to anonymous visitors too.
  app.get('/api/alerts', async () =>
    listActiveAlerts().map(a => ({
      id: a.id,
      message: a.message,
      level: a.level,
      createdAt: a.created_at,
    })),
  );

  // The signed-in user's own profile. Records/refreshes the user on every call
  // (so the directory builds itself as people sign in) and returns their badges.
  app.get('/api/me', { preHandler: requireUser }, async (req) => {
    const { sub, username } = req.user!;
    upsertUser(sub, username);
    return getProfile(sub);
  });

  // Submit an in-game Friend Code for review. Held as a 'pending' request; the
  // admin sends the in-game friend request and sets a confirmation passphrase,
  // then the user confirms (below) to publish it. Capped and trimmed.
  app.post<{ Body: { code?: string } }>(
    '/api/me/flair',
    { preHandler: requireUser },
    async (req, reply) => {
      const { sub, username } = req.user!;
      upsertUser(sub, username);
      const code = typeof req.body?.code === 'string' ? req.body.code.trim().slice(0, 80) : '';
      if (!code) return reply.code(400).send({ error: 'A friend code is required.' });
      submitFlairRequest(sub, code);
      notify('flair.requested', {
        id: sub,
        type: 'flair',
        summary: `Friend code: ${code} — from ${username ?? sub}`,
        createdAt: new Date().toISOString(),
      });
      return getProfile(sub);
    },
  );

  // Cancel/withdraw an active request, or — if there's no active request — clear
  // an already-approved live Friend Code. Same "remove my code" action from the
  // user's perspective; which one applies depends on their current state.
  app.delete('/api/me/flair', { preHandler: requireUser }, async (req) => {
    const { sub, username } = req.user!;
    upsertUser(sub, username);
    const user = getUser(sub);
    if (user?.flair_status) clearFlairRequest(sub);
    else clearFlair(sub);
    return getProfile(sub);
  });

  // Confirm a 'sent' request with the passphrase the admin provided out-of-band.
  // On a (case-insensitive) match the friend code is published to the live flair.
  app.post<{ Body: { passphrase?: string } }>(
    '/api/me/flair/confirm',
    { preHandler: requireUser },
    async (req, reply) => {
      const { sub, username } = req.user!;
      upsertUser(sub, username);
      const passphrase = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
      if (!passphrase.trim()) return reply.code(400).send({ error: 'Enter the confirmation code.' });
      const ok = confirmFlairCode(sub, passphrase);
      return reply.send({ ok, profile: getProfile(sub) });
    },
  );

  // The signed-in user's completed Weekly Sets — Teable record ids, used to
  // render the checkbox column and "hide completed" filter client-side.
  app.get('/api/me/weekly-completions', { preHandler: requireUser }, async (req) => {
    const { sub, username } = req.user!;
    upsertUser(sub, username);
    return completedWeeklySetIds(sub);
  });

  app.put<{ Params: { id: string } }>(
    '/api/me/weekly-completions/:id',
    { preHandler: requireUser },
    async (req) => {
      const { sub, username } = req.user!;
      upsertUser(sub, username);
      markWeeklyCompleted(sub, req.params.id);
      return completedWeeklySetIds(sub);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/me/weekly-completions/:id',
    { preHandler: requireUser },
    async (req) => {
      const { sub, username } = req.user!;
      upsertUser(sub, username);
      clearWeeklyCompleted(sub, req.params.id);
      return completedWeeklySetIds(sub);
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
      const ipHash = hashIp(req.ip);

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
        batch_id: null,
      });

      // Also record the user in the directory so the admin can badge them later.
      if (req.user) upsertUser(req.user.sub, req.user.username);

      req.log.info({ id, type: handler.type, submitter: req.user?.username ?? null }, 'submission received');
      notify('submission.created', { id, type: handler.type, summary, submitterNote: data.sourceLink, createdAt });
      broadcastSse('submission', { id, type: handler.type, summary });
      return reply.send({ ok: true, id });
    },
  );

  // Frog ids that already have a stats submission awaiting review, so the
  // website can hide them from the missing-stats list.
  app.get('/api/frog-stats/pending', async () => pendingPayloadValues('frogStats', 'frogId'));

  // Submits many items of one type in a single request (JSON, no screenshot).
  // Each item becomes its own pending submission, reviewed independently; the
  // response reports per-item acceptance so the website can show what was
  // refused and why. Body: { type, payloads: [...], hp_url }.
  app.post<{ Body: { type?: unknown; payloads?: unknown; hp_url?: unknown } }>(
    '/api/submit/batch',
    { preHandler: optionalUser, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const body = req.body ?? {};

      // Honeypot tripped → pretend success and silently drop.
      if (typeof body.hp_url === 'string' && body.hp_url.trim() !== '') return reply.send({ ok: true, results: [] });

      const handler = getHandler(typeof body.type === 'string' ? body.type : '');
      if (!handler) return reply.code(400).send({ error: 'unknown submission type' });

      const payloads = body.payloads;
      if (!Array.isArray(payloads) || payloads.length === 0) {
        return reply.code(400).send({ error: 'nothing to submit' });
      }
      if (payloads.length > MAX_BATCH) {
        return reply.code(400).send({ error: `too many items (max ${MAX_BATCH})` });
      }

      const checked = await mapLimit(payloads, 8, async (raw): Promise<{ data: unknown } | { error: string }> => {
        const parsed = handler.schema.safeParse(raw);
        if (!parsed.success) {
          return { error: parsed.error.issues.map(i => `${i.path.join('.') || 'item'}: ${i.message}`).join('; ') };
        }
        try {
          await handler.preSubmit?.(parsed.data);
        } catch (e) {
          return { error: e instanceof Error ? e.message : 'Submission not allowed.' };
        }
        return { data: parsed.data };
      });

      const createdAt = new Date().toISOString();
      const ipHash = hashIp(req.ip);
      const batchId = randomUUID();
      const seen = new Set<string>();
      const results: ({ index: number; ok: true; id: string } | { index: number; ok: false; error: string })[] = [];
      const rows: { id: string; summary: string; [col: string]: unknown }[] = [];
      const summaries: string[] = [];

      checked.forEach((c, index) => {
        if ('error' in c) { results.push({ index, ok: false, error: c.error }); return; }
        const key = handler.dedupeKey?.(c.data);
        if (key !== undefined) {
          if (seen.has(key)) { results.push({ index, ok: false, error: 'Duplicate of another item in this submission.' }); return; }
          seen.add(key);
        }
        const id = randomUUID();
        const summary = handler.summarize(c.data);
        rows.push({
          id,
          type: handler.type,
          payload: JSON.stringify(c.data),
          summary,
          screenshot: null,
          submitter_note: null,
          submitter_sub: req.user?.sub ?? null,
          submitter_name: req.user?.username ?? null,
          source_ip: ipHash,
          created_at: createdAt,
          batch_id: batchId,
        });
        summaries.push(summary);
        results.push({ index, ok: true, id });
      });

      if (rows.length > 0) {
        db.transaction(() => { for (const r of rows) queries.insert.run(r); })();
        if (req.user) upsertUser(req.user.sub, req.user.username);

        req.log.info({ type: handler.type, count: rows.length, submitter: req.user?.username ?? null }, 'batch submission received');
        const shown = summaries.slice(0, 10).join('\n');
        const more = summaries.length > 10 ? `\n…and ${summaries.length - 10} more` : '';
        notify('submission.created', {
          id: rows[0].id,
          type: handler.type,
          summary: summaries.length === 1 ? summaries[0] : `${summaries.length} submissions:\n${shown}${more}`,
          createdAt,
        });
        for (const r of rows) broadcastSse('submission', { id: r.id, type: handler.type, summary: r.summary });
      }

      return reply.send({ ok: true, results });
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
