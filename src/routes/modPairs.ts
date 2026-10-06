import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pendingPayloadPairs } from '../db';
import { mapLimit } from '../async';
import {
  resolveFieldId, resolveTableId, teableCreateRecordById, teableFindRecords, teableListRecords,
  teableUpdateRecordById,
} from '../teable';
import { requireUserMod } from '../userAuth';
import { PLATFORM_FIELD_ID, VERSION_FIELD_ID, VISIBLE_FIELD_ID } from '../tasks/versionPoller';

// Mod tool: records parent pairs as Verified with no mutations, straight into
// Frog Pairs (no review queue). Driven by the Mutation Planner's Verify mode.
// Pairs that produce a mutation still go through the combo submission flow.
//
// Only a clean slate is written: a pair already Verified, an unverified record
// still holding data (mutations, screenshots, attribution…), or a pair with a
// combo awaiting review is refused, so the owner can sort it out in Teable.
// Nothing here ever deletes.

const PAIRS_TABLE = 'Frog Pairs';
const FROGS_TABLE = 'Froggies';
const FROG_ID_FIELD = 'fldXdFuyFj6NDz1qjMY'; // Froggies primary field, e.g. "18:11:0"

// The most pairs one check may carry: an 8-frog plan has 28 cross pairs plus 8 self pairs.
const MAX_PAIRS = 64;

const frogIdSchema = z.string().regex(/^\d+:\d+:\d+$/, 'must be a Frog_ID like 18:11:0');
const pairSchema = z.object({ frogA: frogIdSchema, frogB: frogIdSchema });
type Pair = z.infer<typeof pairSchema>;

// ── Frogs ────────────────────────────────────────────────────────────────────

// Frog_ID → record id. Both are stable, so lookups are cached for the process.
const frogRecordIds = new Map<string, string>();

async function frogRecordId(frogId: string): Promise<string> {
  const cached = frogRecordIds.get(frogId);
  if (cached) return cached;
  const tableId = await resolveTableId(FROGS_TABLE);
  const [frog] = await teableFindRecords(tableId, {
    conjunction: 'and',
    filterSet: [{ fieldId: FROG_ID_FIELD, operator: 'is', value: frogId }],
  }, 1);
  if (!frog) throw new Error(`${frogId} is not a known frog.`);
  frogRecordIds.set(frogId, frog.id);
  return frog.id;
}

// ── Version ──────────────────────────────────────────────────────────────────

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// The newest version released on both iOS and Android — e.g. iOS at 2.3 and
// Android at 2.2, both having had 2.1, gives 2.1. Legacy "Both" rows count for
// each platform. Cached briefly, since a check and its verifies ask repeatedly.
const VERSION_TTL_MS = 5 * 60_000;
let versionCache: { value: string; at: number } | null = null;

async function commonVersion(): Promise<string> {
  if (versionCache && Date.now() - versionCache.at < VERSION_TTL_MS) return versionCache.value;
  const rows = await teableListRecords(await resolveTableId('Changelog'));
  const ios = new Set<string>(), android = new Set<string>();
  for (const { fields } of rows) {
    const version = fields[VERSION_FIELD_ID], platform = fields[PLATFORM_FIELD_ID];
    if (fields[VISIBLE_FIELD_ID] !== true || typeof version !== 'string' || !/^\d+(\.\d+)*$/.test(version)) continue;
    if (platform === 'iOS' || platform === 'Both') ios.add(version);
    if (platform === 'Android' || platform === 'Both') android.add(version);
  }
  const common = [...ios].filter(v => android.has(v)).sort(compareVersions);
  const value = common.at(-1);
  if (!value) throw new Error('No game version has been released on both platforms.');
  versionCache = { value, at: Date.now() };
  return value;
}

// ── Pairs ────────────────────────────────────────────────────────────────────

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// A cell counts as holding data unless it's empty — Teable omits blank fields.
const hasValue = (v: unknown) =>
  v !== undefined && v !== null && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0);

interface Ready {
  frogA: string; // record ids
  frogB: string;
  existingId: string | null; // a blank, unverified record to fill in, if there is one
}

// Everything that would stop a pair being recorded as clear. Throws a
// user-facing message, or returns what's needed to write it.
async function checkPair(pair: Pair, pendingCombos: Set<string>): Promise<Ready> {
  const [frogA, frogB] = await Promise.all([frogRecordId(pair.frogA), frogRecordId(pair.frogB)]);

  if (pendingCombos.has(pairKey(frogA, frogB))) {
    throw new Error('Has a combo submission awaiting review.');
  }

  const tableId = await resolveTableId(PAIRS_TABLE);
  const field = (dbFieldName: string) => resolveFieldId(tableId, { dbFieldName });
  const [aField, bField] = await Promise.all([field('frogA'), field('frogb')]);
  const ordered = (a: string, b: string) => ({
    conjunction: 'and',
    filterSet: [
      { fieldId: aField, operator: 'is', value: a },
      { fieldId: bField, operator: 'is', value: b },
    ],
  });
  const found = await teableFindRecords(tableId, {
    conjunction: 'or',
    filterSet: [ordered(frogA, frogB), ordered(frogB, frogA)],
  }, 2);
  if (found.length === 0) return { frogA, frogB, existingId: null };
  if (found.length > 1) throw new Error('Recorded more than once — needs cleanup in Teable.');

  const [record] = found;
  if (record.fields[await field('verified')] === true) throw new Error('Already verified.');
  if (hasValue(record.fields[await field('mutations')])) {
    throw new Error('Has mutation records — needs cleanup in Teable.');
  }
  for (const name of ['screenshot', 'source_link', 'submitter', 'version']) {
    if (hasValue(record.fields[await field(name)])) {
      throw new Error('Has leftover data — needs cleanup in Teable.');
    }
  }
  return { frogA, frogB, existingId: record.id };
}

function pendingComboKeys(): Set<string> {
  return new Set(pendingPayloadPairs('combo', 'frog1Id', 'frog2Id').map(([a, b]) => pairKey(a, b)));
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Could not check this pair.');

export async function registerModPairRoutes(app: FastifyInstance) {
  // Dry run before a bulk verify: which pairs can be recorded, and why the
  // rest can't. Results are in the order the pairs were sent.
  app.post<{ Body: { pairs?: unknown } }>(
    '/api/mod/pairs/check',
    { preHandler: requireUserMod, config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const parsed = z.array(pairSchema).min(1).max(MAX_PAIRS).safeParse(req.body?.pairs);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid pair list' });

      let version: string;
      try {
        version = await commonVersion();
      } catch (e) {
        return reply.code(409).send({ error: errorText(e) });
      }
      const pending = pendingComboKeys();
      const results = await mapLimit(parsed.data, 4, async (pair) => {
        try {
          await checkPair(pair, pending);
          return { ok: true as const };
        } catch (e) {
          return { ok: false as const, error: errorText(e) };
        }
      });
      return reply.send({ version, results });
    },
  );

  // Records one pair as Verified with no mutations. The page sends pairs one at
  // a time so each can show its outcome as it lands. Rechecks everything, in
  // case another mod or an approval got there since the check.
  app.post<{ Body: unknown }>(
    '/api/mod/pairs/verify',
    { preHandler: requireUserMod, config: { rateLimit: { max: 200, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const parsed = pairSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid pair' });

      try {
        const version = await commonVersion();
        const ready = await checkPair(parsed.data, pendingComboKeys());
        const tableId = await resolveTableId(PAIRS_TABLE);
        const field = (dbFieldName: string) => resolveFieldId(tableId, { dbFieldName });
        // Store the stable Authentik ID so attribution survives username changes.
        const fields: Record<string, unknown> = {
          [await field('verified')]: true,
          [await field('submitter')]: req.user!.sub,
          [await field('version')]: version,
        };
        let pairId: string;
        if (ready.existingId) {
          pairId = ready.existingId;
          await teableUpdateRecordById(tableId, pairId, fields);
        } else {
          fields[await field('frogA')] = { id: ready.frogA };
          fields[await field('frogb')] = { id: ready.frogB };
          pairId = await teableCreateRecordById(tableId, fields);
        }
        req.log.info({ ...parsed.data, pairId, mod: req.user!.username }, 'pair verified clear');
        return reply.send({ ok: true, pairId });
      } catch (e) {
        return reply.code(409).send({ error: errorText(e) });
      }
    },
  );
}
