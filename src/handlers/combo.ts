import { z } from 'zod';
import type { SubmissionHandler } from '../types';
import {
  resolveFieldId, resolveTableId, teableCreateRecordById, teableFindRecords, teableGetRecordById,
  teableUpdateRecordById, teableUploadAttachmentToRecord,
} from '../teable';
import { VERSION_FIELD_ID } from '../tasks/versionPoller';

// A community-submitted Chroma or Glass mutation. The website resolves every
// picked frog to its real Teable record, so we receive record ids directly —
// making the downstream push a set of clean link-record references.
//
//   frog1 / frog2  — the parent pair (required)
//   resultFrog     — the special frog the pair produces (required)
//   lostFrog       — the normal offspring it replaces (optional)
//   sourceLink     — attribution: where the combo was posted (optional)
//   version        — game version string it was found on, e.g. "1.2.3" (optional);
//                    must exist in the Changelog table, stored on the pair as text
//
// Downstream, every parent pair is one "Frog Pairs" record, and each mutation it
// produces is a "Mutations" record linked back to it. A Verified pair is taken
// as accurate and closed to submissions. An unverified one is missing data or
// flagged as wrong, so an approved submission overwrites it and verifies it.
export const comboSchema = z.object({
  variant: z.enum(['chroma', 'glass']),
  frog1Id: z.string().min(1).max(40),
  frog2Id: z.string().min(1).max(40),
  frog1Name: z.string().min(1).max(120),
  frog2Name: z.string().min(1).max(120),
  resultFrogId: z.string().min(1).max(40),
  resultFrogName: z.string().min(1).max(120),
  lostFrogId: z.string().min(1).max(40).optional(),
  lostFrogName: z.string().min(1).max(120).optional(),
  sourceLink: z.string().url().max(500).optional(),
  versionName: z.string().min(1).max(40).optional(),
}).refine((p) => !p.lostFrogId === !p.lostFrogName, {
  message: 'lostFrogId and lostFrogName must be given together',
  path: ['lostFrogId'],
});

export type ComboPayload = z.infer<typeof comboSchema>;

const PAIRS_TABLE = 'Frog Pairs';
const MUTATIONS_TABLE = 'Mutations';
const FROGS_TABLE = 'Froggies';

// Each frog travels as a record id plus its name. The id is what gets pushed;
// the name is what reviewers read. Confirms every pair still agrees, so a
// payload can't name one frog while linking another.
async function checkFrogNames(p: ComboPayload): Promise<void> {
  const frogs: [string, string, string | undefined][] = [
    ['Parent 1', p.frog1Id, p.frog1Name],
    ['Parent 2', p.frog2Id, p.frog2Name],
    ['Result',   p.resultFrogId, p.resultFrogName],
  ];
  if (p.lostFrogId) frogs.push(['Lost frog', p.lostFrogId, p.lostFrogName]);

  const tableId = await resolveTableId(FROGS_TABLE);
  const nameField = await resolveFieldId(tableId, { dbFieldName: 'fullname' });
  await Promise.all(frogs.map(async ([role, id, name]) => {
    const record = await teableGetRecordById(tableId, id);
    if (!record) throw new Error(`${role}: ${id} is not a known frog record.`);
    const actual = String(record[nameField] ?? '');
    if (actual !== name) throw new Error(`${role}: record ${id} is ${actual}, not ${name}.`);
  }));
}

async function checkVersion(p: ComboPayload): Promise<void> {
  if (!p.versionName) return;
  const changelogId = await resolveTableId('Changelog');
  const [known] = await teableFindRecords(changelogId, {
    conjunction: 'and',
    filterSet: [{ fieldId: VERSION_FIELD_ID, operator: 'is', value: p.versionName }],
  }, 1);
  if (!known) throw new Error('The selected game version is not recognised.');
}

// Everything a combo must satisfy before it's stored — on submit and on edit.
async function validateCombo(p: ComboPayload): Promise<void> {
  await findOpenPair(p);
  await checkVersion(p);
  await checkFrogNames(p);
}

const typeLabel = (p: ComboPayload) => (p.variant === 'chroma' ? 'Chroma' : 'Glass');

// Record ids from a link cell — a single { id, title } or an array of them.
function linkIds(val: unknown): string[] {
  const arr = Array.isArray(val) ? val : val ? [val] : [];
  return arr
    .map((v) => (v && typeof v === 'object' && 'id' in v ? String((v as { id: unknown }).id) : null))
    .filter((id): id is string => !!id);
}

// Looks up the parent pair (either order). Returns null if it isn't recorded
// yet; throws if it's already Verified.
async function findOpenPair(p: ComboPayload): Promise<{ id: string; fields: Record<string, unknown> } | null> {
  const tableId = await resolveTableId(PAIRS_TABLE);
  const frogA = await resolveFieldId(tableId, { dbFieldName: 'frogA' });
  const frogB = await resolveFieldId(tableId, { dbFieldName: 'frogb' });
  const ordered = (a: string, b: string) => ({
    conjunction: 'and',
    filterSet: [
      { fieldId: frogA, operator: 'is', value: a },
      { fieldId: frogB, operator: 'is', value: b },
    ],
  });
  const [pair] = await teableFindRecords(tableId, {
    conjunction: 'or',
    filterSet: [ordered(p.frog1Id, p.frog2Id), ordered(p.frog2Id, p.frog1Id)],
  }, 1);
  if (!pair) return null;

  if (pair.fields[await resolveFieldId(tableId, { dbFieldName: 'verified' })] === true) {
    throw new Error(`${p.frog1Name} + ${p.frog2Name} is already verified — corrections aren't accepted yet.`);
  }
  return pair;
}

export const comboHandler: SubmissionHandler<ComboPayload> = {
  type: 'combo',
  label: 'Chroma / Glass combination',
  acceptsScreenshot: true,
  schema: comboSchema,
  preSubmit: validateCombo,
  preEdit: validateCombo,
  summarize: (p) => {
    const head = `${typeLabel(p)}: ${p.frog1Name} + ${p.frog2Name}`;
    const result = ` → ${p.resultFrogName}`;
    const lost = p.lostFrogName ? ` (replaces ${p.lostFrogName})` : '';
    const version = p.versionName ? ` [v${p.versionName}]` : '';
    return head + result + lost + version;
  },
  async pushDown(p, ctx) {
    const pairsId = await resolveTableId(PAIRS_TABLE);
    const pairField = (dbFieldName: string) => resolveFieldId(pairsId, { dbFieldName });

    // Approval verifies the pair. An existing (unverified) pair is overwritten
    // with the submission — fields it leaves blank are cleared, not kept.
    // Link fields take { id } references; source_link and version are plain text.
    // Store the stable Authentik ID so attribution survives username changes.
    const existing = await findOpenPair(p);
    const screenshotField = await pairField('screenshot');
    const pairFields: Record<string, unknown> = {
      [await pairField('verified')]: true,
      [await pairField('source_link')]: p.sourceLink || null,
      [await pairField('submitter')]: ctx.submitterSub || null,
      [await pairField('version')]: p.versionName || null,
    };

    let pairId: string;
    if (existing) {
      pairId = existing.id;
      // The new screenshot replaces the old one(s) rather than adding to them.
      if (ctx.screenshotPath) pairFields[screenshotField] = null;
      await teableUpdateRecordById(pairsId, pairId, pairFields);
    } else {
      pairFields[await pairField('frogA')] = { id: p.frog1Id };
      pairFields[await pairField('frogb')] = { id: p.frog2Id };
      pairId = await teableCreateRecordById(pairsId, pairFields);
    }

    // The mutation links back to the pair; Teable fills the pair's Mutations
    // side. A same-type mutation already on an unverified pair is overwritten.
    const mutId = await resolveTableId(MUTATIONS_TABLE);
    const mutField = (dbFieldName: string) => resolveFieldId(mutId, { dbFieldName });
    const typeField = await mutField('type');
    let mutationId: string | null = null;
    if (existing) {
      for (const id of linkIds(existing.fields[await pairField('mutations')])) {
        if ((await teableGetRecordById(mutId, id))?.[typeField] === typeLabel(p)) { mutationId = id; break; }
      }
    }
    const mutFields: Record<string, unknown> = {
      [await mutField('result')]: { id: p.resultFrogId },
      [await mutField('lost')]: p.lostFrogId ? { id: p.lostFrogId } : null,
    };
    if (mutationId) {
      await teableUpdateRecordById(mutId, mutationId, mutFields);
    } else {
      mutFields[await mutField('pair')] = { id: pairId };
      mutFields[typeField] = typeLabel(p);
      mutationId = await teableCreateRecordById(mutId, mutFields);
    }

    if (ctx.screenshotPath && pairId) {
      await teableUploadAttachmentToRecord(pairsId, pairId, screenshotField, ctx.screenshotPath);
    }

    return mutationId;
  },
};
