import type { FastifyInstance } from 'fastify';
import { cropImage, storeScreenshot } from '../imageProcess';
import {
  getById, listByStatus, listPendingInBatch, deleteById, setStatus, updatePending, setSubmitterNote, setSubmitter,
  type SubmissionRow,
} from '../db';
import { deleteObject, getObject, mimeFor, putObject } from '../storage';
import { getHandler } from '../handlers/registry';
import { requireUserAdmin } from '../userAuth';
import { notify } from '../notify';
import { broadcastSse } from '../sse';
import { getUser } from '../users';

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
    submitter: r.submitter_name, // null → anonymous submission
    submitterSub: r.submitter_sub,
    screenshot: r.screenshot ? `/api/admin/uploads/${r.screenshot}` : null,
    // Uncropped upload, present only while an auto-cropped screenshot is pending.
    screenshotOriginal: r.screenshot && r.screenshot_original ? `/api/admin/uploads/${r.screenshot_original}` : null,
    createdAt: r.created_at,
    batchId: r.batch_id,
  };
}

// Pushes one pending submission downstream and records the outcome on its row:
// 'pushed' with the downstream ref, or 'error' with the message kept.
async function approveRow(row: SubmissionRow): Promise<{ ok: true; ref: string | null } | { ok: false; error: string }> {
  const handler = getHandler(row.type);
  if (!handler) return { ok: false, error: `no handler for type "${row.type}"` };
  try {
    const payload = JSON.parse(row.payload);
    const data = row.screenshot ? await getObject(row.screenshot) : null;
    if (row.screenshot && !data) throw new Error(`screenshot ${row.screenshot} is missing from storage`);
    const screenshot = row.screenshot && data ? { name: row.screenshot, data } : null;
    const ref = (await handler.pushDown(payload, {
      screenshot,
      submitterSub: row.submitter_sub,
      submitterName: row.submitter_name,
    })) || null;
    await setStatus({
      id: row.id, status: 'pushed', reviewer_note: null, reviewed_at: new Date().toISOString(), pushed_ref: ref,
    });
    await deleteObject(row.screenshot_original).catch(() => { /* orphan is harmless */ });
    return { ok: true, ref };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setStatus({
      id: row.id, status: 'error', reviewer_note: message, reviewed_at: new Date().toISOString(), pushed_ref: null,
    });
    return { ok: false, error: message };
  }
}

// Deletes a submission and its screenshot (rejections aren't retained).
async function discardRow(row: SubmissionRow): Promise<void> {
  await deleteObject(row.screenshot_original);
  await deleteObject(row.screenshot);
  await deleteById(row.id);
}

// Notification text for a group action: "12 of 12 approved: …first few…".
function batchSummary(done: SubmissionRow[], total: number, verb: string): string {
  const shown = done.slice(0, 10).map(r => r.summary).join('\n');
  const more = done.length > 10 ? `\n…and ${done.length - 10} more` : '';
  return `${done.length} of ${total} ${verb}:\n${shown}${more}`;
}

// Submission review API. Gated by the SPA bearer-token admin check so the React
// /admin pages drive it; the review UI itself now lives in the website.
export async function registerAdminRoutes(app: FastifyInstance) {
  await app.register(async (admin) => {
    admin.addHook('preHandler', requireUserAdmin);

    // JSON list of pending submissions (the React admin page polls this).
    admin.get('/api/admin/pending', async () => (await listByStatus('pending')).map(toDto));

    // Serve an uploaded screenshot for review. Admin-gated, so the SPA fetches it
    // with the bearer token and renders it via an object URL.
    admin.get('/api/admin/uploads/:file', async (req, reply) => {
      const file = (req.params as { file: string }).file;
      if (!/^[\w.-]+$/.test(file)) return reply.code(400).send('bad filename');
      const data = await getObject(file);
      if (!data) return reply.code(404).send('not found');
      return reply.type(mimeFor(file)).send(data);
    });

    // Approve → push downstream → mark pushed (or error, with the message kept).
    admin.post('/api/admin/:id/approve', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const row = await getById(id);
      if (!row) return reply.code(404).send({ error: 'not found' });
      if (row.status !== 'pending') return reply.code(409).send({ error: `already ${row.status}` });

      const result = await approveRow(row);
      if (!result.ok) {
        req.log.error({ id, err: result.error }, 'push failed');
        return reply.code(502).send({ error: 'push failed', detail: result.error });
      }
      req.log.info({ id, ref: result.ref }, 'submission pushed');
      notify('submission.approved', { id: row.id, type: row.type, summary: row.summary, submitterNote: row.submitter_note, createdAt: row.created_at });
      broadcastSse('submission', { id, action: 'approved' });
      return { ok: true, pushed_ref: result.ref };
    });

    // Approve every still-pending item of a batch, one at a time. Failures are
    // recorded per item (as with a single approve) and don't stop the rest.
    admin.post<{ Params: { batchId: string } }>('/api/admin/batch/:batchId/approve', async (req, reply) => {
      const rows = await listPendingInBatch(req.params.batchId);
      if (rows.length === 0) return reply.code(404).send({ error: 'no pending items in this batch' });

      const results: { id: string; summary: string; ok: boolean; error?: string }[] = [];
      for (const row of rows) {
        const r = await approveRow(row);
        results.push(r.ok ? { id: row.id, summary: row.summary, ok: true } : { id: row.id, summary: row.summary, ok: false, error: r.error });
        broadcastSse('submission', { id: row.id, action: r.ok ? 'approved' : 'error' });
      }

      const pushed = rows.filter((_, i) => results[i].ok);
      req.log.info({ batchId: req.params.batchId, pushed: pushed.length, total: rows.length }, 'batch approved');
      if (pushed.length > 0) {
        notify('submission.approved', { id: pushed[0].id, type: pushed[0].type, summary: batchSummary(pushed, rows.length, 'approved'), createdAt: pushed[0].created_at });
      }
      return { ok: true, results };
    });

    // Reject → discard every still-pending item of a batch.
    admin.post<{ Params: { batchId: string } }>('/api/admin/batch/:batchId/reject', async (req, reply) => {
      const rows = await listPendingInBatch(req.params.batchId);
      if (rows.length === 0) return reply.code(404).send({ error: 'no pending items in this batch' });

      for (const row of rows) {
        await discardRow(row);
        broadcastSse('submission', { id: row.id, action: 'rejected' });
      }
      notify('submission.rejected', { id: rows[0].id, type: rows[0].type, summary: batchSummary(rows, rows.length, 'rejected'), createdAt: rows[0].created_at });
      return { ok: true, count: rows.length };
    });

    // Edit → update payload and/or screenshot, leave status as pending.
    admin.patch('/api/admin/:id', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const row = await getById(id);
      if (!row) return reply.code(404).send({ error: 'not found' });
      if (row.status !== 'pending') return reply.code(409).send({ error: `cannot edit: already ${row.status}` });

      const handler = getHandler(row.type);
      if (!handler) return reply.code(500).send({ error: `no handler for type "${row.type}"` });

      let payloadStr = '';
      let newFileBuf: Buffer | null = null;
      let clearScreenshot = false;
      // Absent → credit unchanged; '' → anonymous; '~Name' → a non-user credited
      // by display name; otherwise a known user's sub.
      let submitterSub: string | undefined;

      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname === 'screenshot') {
            const ext = IMAGE_EXT[part.mimetype];
            const buf = await part.toBuffer();
            if (ext && buf.length > 0) { newFileBuf = buf; }
          } else {
            await part.toBuffer();
          }
        } else if (part.fieldname === 'payload') {
          payloadStr = String(part.value);
        } else if (part.fieldname === 'clearScreenshot') {
          clearScreenshot = String(part.value) === '1';
        } else if (part.fieldname === 'submitterSub') {
          submitterSub = String(part.value);
        }
      }

      let raw: unknown;
      try { raw = JSON.parse(payloadStr || '{}'); }
      catch { return reply.code(400).send({ error: 'invalid payload JSON' }); }

      // Edits meet the same schema as submissions, so a bad value is refused
      // here rather than surfacing as a failed push on approve.
      const parsed = handler.schema.safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues.map(i => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; ');
        return reply.code(400).send({ error: 'validation failed', detail });
      }
      const payload = parsed.data;

      if (handler.preEdit) {
        try {
          await handler.preEdit(payload);
        } catch (e) {
          return reply.code(409).send({ error: e instanceof Error ? e.message : 'Edit not allowed.' });
        }
      }

      let submitter: { sub: string | null; name: string | null } | null = null;
      if (submitterSub !== undefined) {
        if (submitterSub === '') {
          submitter = { sub: null, name: null };
        } else if (submitterSub.startsWith('~')) {
          // Stored as-is: the '~' marks the Submitter as a manual credit downstream.
          const name = submitterSub.slice(1).trim().replace(/\s+/g, ' ');
          if (!name) return reply.code(400).send({ error: 'Enter a display name for the non-user submitter.' });
          if (name.length > 80) return reply.code(400).send({ error: 'Display name is too long (80 characters max).' });
          submitter = { sub: `~${name}`, name };
        } else {
          const user = await getUser(submitterSub);
          if (!user) return reply.code(400).send({ error: 'Unknown submitter — they must have signed in to the site.' });
          submitter = { sub: user.sub, name: user.username };
        }
      }

      const summary = handler.summarize(payload);

      let screenshot = row.screenshot;
      let screenshotOriginal = row.screenshot_original;
      if (newFileBuf || (clearScreenshot && row.screenshot)) {
        await deleteObject(row.screenshot);
        await deleteObject(row.screenshot_original);
        screenshot = screenshotOriginal = null;
      }
      if (newFileBuf) {
        ({ screenshot, original: screenshotOriginal } =
          await storeScreenshot(id, newFileBuf, { autoCrop: !!handler.autoCropScreenshot }));
      }

      await updatePending({
        id, payload: JSON.stringify(payload), summary, screenshot, screenshot_original: screenshotOriginal,
      });
      await setSubmitterNote(id, (payload as { sourceLink?: string }).sourceLink ?? null);
      if (submitter) await setSubmitter(id, submitter.sub, submitter.name);
      req.log.info({ id }, 'submission edited');
      broadcastSse('submission', { id, action: 'edited' });
      return { ok: true, summary };
    });

    // Crop → re-encode the stored screenshot to the given region. With
    // fromOriginal, the region is taken from the kept uncropped upload instead
    // (redoing a bad auto-crop); the original stays so it can be redone again.
    admin.post<{ Params: { id: string } }>('/api/admin/:id/crop', async (req, reply) => {
      const { id } = req.params;
      const row = await getById(id);
      if (!row) return reply.code(404).send({ error: 'not found' });
      if (!row.screenshot) return reply.code(400).send({ error: 'no screenshot' });

      const { left, top, right, bottom, fromOriginal } =
        req.body as { left: number; top: number; right: number; bottom: number; fromOriginal?: boolean };
      const srcKey = fromOriginal ? row.screenshot_original : row.screenshot;
      const src = srcKey ? await getObject(srcKey) : null;
      if (!src) return reply.code(400).send({ error: fromOriginal ? 'no original screenshot kept' : 'screenshot missing' });
      const { data, ext } = await cropImage(src, { left, top, right, bottom });

      const newFilename = `${id}.${ext}`;
      await putObject(newFilename, data);
      if (row.screenshot !== newFilename) await deleteObject(row.screenshot);

      await updatePending({
        id, payload: row.payload, summary: row.summary, screenshot: newFilename, screenshot_original: row.screenshot_original,
      });
      req.log.info({ id }, 'screenshot cropped');
      return { ok: true, screenshot: `/api/admin/uploads/${newFilename}` };
    });

    // Reject → discard the submission entirely (row + screenshot). Rejected
    // submissions are not retained.
    admin.post('/api/admin/:id/reject', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const row = await getById(id);
      if (!row) return reply.code(404).send({ error: 'not found' });

      await discardRow(row);

      notify('submission.rejected', { id, type: row.type, summary: row.summary, submitterNote: row.submitter_note, createdAt: row.created_at });
      broadcastSse('submission', { id, action: 'rejected' });
      return { ok: true };
    });
  });
}
