import { z } from 'zod';
import type { SubmissionHandler } from '../types';
import { resolveFieldId, teableCreateRecordById, teableUploadAttachment } from '../teable';
import { config } from '../config';

// A community-submitted Chroma or Glass combination. The website resolves every
// picked frog to its real Teable record, so we receive record ids directly —
// making the downstream push a set of clean link-record references.
//
//   frog1 / frog2  — the parent pair (required)
//   resultFrog     — the special frog the pair produces (required)
//   lostFrog       — the normal offspring it replaces (optional)
//   sourceLink     — attribution: where the combo was posted (optional)
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
});

export type ComboPayload = z.infer<typeof comboSchema>;

export const comboHandler: SubmissionHandler<ComboPayload> = {
  type: 'combo',
  label: 'Chroma / Glass combination',
  acceptsScreenshot: true,
  schema: comboSchema,
  summarize: (p) => {
    const head = `${p.variant === 'chroma' ? 'Chroma' : 'Glass'}: ${p.frog1Name} + ${p.frog2Name}`;
    const result = ` → ${p.resultFrogName}`;
    const lost = p.lostFrogName ? ` (replaces ${p.lostFrogName})` : '';
    return head + result + lost;
  },
  async pushDown(p, ctx) {
    const tableId =
      p.variant === 'chroma' ? config.teable.tables.chroma : config.teable.tables.glass;

    // Resolve each target field to its id, then build the record. Link fields
    // take an array of { id } references; source_link is a plain URL string.
    const fields: Record<string, unknown> = {
      [await resolveFieldId(tableId, { name: 'Frog 1' })]: [{ id: p.frog1Id }],
      [await resolveFieldId(tableId, { name: 'Frog 2' })]: [{ id: p.frog2Id }],
      [await resolveFieldId(tableId, { dbFieldName: 'result_frog' })]: [{ id: p.resultFrogId }],
    };
    if (p.lostFrogId) {
      fields[await resolveFieldId(tableId, { dbFieldName: 'lost_frog' })] = [{ id: p.lostFrogId }];
    }
    if (p.sourceLink) {
      fields[await resolveFieldId(tableId, { dbFieldName: 'source_link' })] = p.sourceLink;
    }
    if (ctx.screenshotPath) {
      const attachment = await teableUploadAttachment(ctx.screenshotPath);
      fields[await resolveFieldId(tableId, { dbFieldName: 'screenshot' })] = [attachment];
    }

    return teableCreateRecordById(tableId, fields);
  },
};
