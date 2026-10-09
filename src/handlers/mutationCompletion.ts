import { z } from 'zod';
import type { SubmissionHandler } from '../types';
import { pendingPayloadValues } from '../db';
import {
  resolveFieldId, resolveTableId, teableGetRecordById, teableUpdateRecordById, teableUploadAttachmentToRecord,
} from '../teable';

// Fills in what a recorded mutation is missing: its Lost Frog and/or its pair's
// screenshot. This is the one submission a Verified pair accepts — it only
// fills gaps, never changes recorded data, so the pair stays trustworthy.
//
// Both items always come together: the screenshot is the evidence for the lost
// frog. A lost frog the mutation already records is passed through unchanged
// (and must match), like the known stats on a frog-stats submission.
//
//   mutationId      — the Mutations record being completed
//   lostFrogId/Name — the normal offspring the mutation replaced
//   the other names — context for reviewers; checked against the records
export const mutationCompletionSchema = z.object({
  mutationId: z.string().min(1).max(40),
  variant: z.enum(['Glass', 'Chroma']),
  frog1Name: z.string().min(1).max(120),
  frog2Name: z.string().min(1).max(120),
  resultFrogName: z.string().min(1).max(120),
  lostFrogId: z.string().min(1).max(40),
  lostFrogName: z.string().min(1).max(120),
});

export type MutationCompletionPayload = z.infer<typeof mutationCompletionSchema>;

const PAIRS_TABLE = 'Frog Pairs';
const MUTATIONS_TABLE = 'Mutations';
const FROGS_TABLE = 'Froggies';

// The first record id in a link cell — a single { id, title } or an array of them.
function linkId(val: unknown): string | null {
  const first = Array.isArray(val) ? val[0] : val;
  return first && typeof first === 'object' && 'id' in first ? String((first as { id: unknown }).id) : null;
}

interface FrogParts { name: string; base: string | null; sec: string | null; breed: string | null }

async function frogParts(id: string | null, role: string): Promise<FrogParts> {
  const tableId = await resolveTableId(FROGS_TABLE);
  const record = id ? await teableGetRecordById(tableId, id) : null;
  if (!record) throw new Error(`${role}: ${id ?? '(none)'} is not a known frog record.`);
  const field = (dbFieldName: string) => resolveFieldId(tableId, { dbFieldName });
  return {
    name: String(record[await field('fullname')] ?? ''),
    base: linkId(record[await field('Primary')]),
    sec: linkId(record[await field('Secondary')]),
    breed: linkId(record[await field('Breed')]),
  };
}

interface Plan {
  pairsId: string;
  pairId: string;
  mutationsId: string;
  lostField: string;
  needsLost: boolean;
}

// Checks the submission against the live records and works out what to write.
// Throws if the mutation is gone, already complete, on an unverified pair (those
// go through the combo form, which overwrites), or the frogs don't line up.
async function planUpdate(p: MutationCompletionPayload): Promise<Plan> {
  const mutationsId = await resolveTableId(MUTATIONS_TABLE);
  const mutField = (dbFieldName: string) => resolveFieldId(mutationsId, { dbFieldName });
  const mutation = await teableGetRecordById(mutationsId, p.mutationId);
  if (!mutation) throw new Error(`The ${p.variant} mutation of ${p.frog1Name} + ${p.frog2Name} is no longer recorded.`);
  const head = `${p.frog1Name} + ${p.frog2Name} → ${p.resultFrogName}`;

  if (mutation[await mutField('type')] !== p.variant) throw new Error(`${head}: the mutation isn't ${p.variant}.`);

  const pairsId = await resolveTableId(PAIRS_TABLE);
  const pairField = (dbFieldName: string) => resolveFieldId(pairsId, { dbFieldName });
  const pairId = linkId(mutation[await mutField('pair')]);
  const pair = pairId ? await teableGetRecordById(pairsId, pairId) : null;
  if (!pairId || !pair) throw new Error(`${head}: the mutation has no breeding pair.`);
  if (pair[await pairField('verified')] !== true) {
    throw new Error(`${head}: the pair isn't verified — submit it through the Mutations form instead.`);
  }

  const lostField = await mutField('lost');
  const recordedLost = linkId(mutation[lostField]);
  const shots = pair[await pairField('screenshot')];
  const hasShot = Array.isArray(shots) && shots.length > 0;
  if (recordedLost && hasShot) throw new Error(`${head} is already complete.`);
  if (recordedLost && recordedLost !== p.lostFrogId) {
    throw new Error(`${head} already records a different lost frog — corrections aren't accepted yet.`);
  }

  const [a, b, result, lost] = await Promise.all([
    frogParts(linkId(pair[await pairField('frogA')]), 'Parent 1'),
    frogParts(linkId(pair[await pairField('frogb')]), 'Parent 2'),
    frogParts(linkId(mutation[await mutField('result')]), 'Result'),
    frogParts(p.lostFrogId, 'Lost frog'),
  ]);

  // The names are what reviewers read, so they must describe these records.
  // Parents may be stored in either order.
  const parentsMatch =
    (a.name === p.frog1Name && b.name === p.frog2Name) || (a.name === p.frog2Name && b.name === p.frog1Name);
  if (!parentsMatch) throw new Error(`${head}: the parents are recorded as ${a.name} + ${b.name}.`);
  if (result.name !== p.resultFrogName) throw new Error(`${head}: the result is recorded as ${result.name}.`);
  if (lost.name !== p.lostFrogName) throw new Error(`Lost frog: record ${p.lostFrogId} is ${lost.name}, not ${p.lostFrogName}.`);

  // The mutation swaps one color: the lost frog is the result with that color
  // (base for Glass, secondary for Chroma) taken from one of the parents.
  const glass = p.variant === 'Glass';
  const keepsResult = lost.breed === result.breed && (glass ? lost.sec === result.sec : lost.base === result.base);
  const parentColor = glass ? [a.base, b.base].includes(lost.base) : [a.sec, b.sec].includes(lost.sec);
  if (!keepsResult || !parentColor) {
    throw new Error(
      `${head}: ${p.lostFrogName} can't be the lost frog — it must be the result with its ` +
      `${glass ? 'base' : 'secondary'} color taken from a parent.`,
    );
  }

  return { pairsId, pairId, mutationsId, lostField, needsLost: !recordedLost };
}

export const mutationCompletionHandler: SubmissionHandler<MutationCompletionPayload> = {
  type: 'mutationCompletion',
  label: 'Mutation completion',
  acceptsScreenshot: true,
  requiresScreenshot: true,
  autoCropScreenshot: true,
  schema: mutationCompletionSchema,
  async preSubmit(p) {
    if (pendingPayloadValues('mutationCompletion', 'mutationId').includes(p.mutationId)) {
      throw new Error(`${p.frog1Name} + ${p.frog2Name} → ${p.resultFrogName} already has a submission pending review.`);
    }
    await planUpdate(p);
  },
  async preEdit(p) { await planUpdate(p); },
  dedupeKey: (p) => p.mutationId,
  summarize: (p) => `${p.variant}: ${p.frog1Name} + ${p.frog2Name} → ${p.resultFrogName} — lost ${p.lostFrogName}`,
  async pushDown(p, ctx) {
    if (!ctx.screenshotPath) throw new Error('A screenshot is required to complete a mutation.');
    const plan = await planUpdate(p);

    if (plan.needsLost) {
      await teableUpdateRecordById(plan.mutationsId, p.mutationId, { [plan.lostField]: { id: p.lostFrogId } });
    }

    // Credit goes on the pair. An anonymous completion leaves the existing
    // credit alone rather than clearing it.
    const pairField = (dbFieldName: string) => resolveFieldId(plan.pairsId, { dbFieldName });
    if (ctx.submitterSub) {
      await teableUpdateRecordById(plan.pairsId, plan.pairId, { [await pairField('submitter')]: ctx.submitterSub });
    }
    // Added alongside any screenshot the pair already has (another of its
    // mutations may rely on it), never replacing it.
    await teableUploadAttachmentToRecord(plan.pairsId, plan.pairId, await pairField('screenshot'), ctx.screenshotPath);

    return p.mutationId;
  },
};
