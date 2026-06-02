import { z } from 'zod';
import type { SubmissionHandler } from '../types';
import { teableCreateRecord } from '../teable';
import { config } from '../config';

// A community-submitted Chroma or Glass combination: two parent frogs that are
// claimed to produce a special offspring. The website resolves each picked frog
// to its real Teable record, so we receive the record ids directly — making the
// downstream push a clean link-record create.
export const comboSchema = z.object({
  variant: z.enum(['chroma', 'glass']),
  frog1Id: z.string().min(1).max(40),
  frog2Id: z.string().min(1).max(40),
  frog1Name: z.string().min(1).max(120),
  frog2Name: z.string().min(1).max(120),
  note: z.string().max(500).optional(),
});

export type ComboPayload = z.infer<typeof comboSchema>;

export const comboHandler: SubmissionHandler<ComboPayload> = {
  type: 'combo',
  label: 'Chroma / Glass combination',
  acceptsScreenshot: true,
  schema: comboSchema,
  summarize: (p) =>
    `${p.variant === 'chroma' ? 'Chroma' : 'Glass'}: ${p.frog1Name} + ${p.frog2Name}`,
  async pushDown(p) {
    const tableId =
      p.variant === 'chroma' ? config.teable.tables.chroma : config.teable.tables.glass;
    // Link fields take an array of { id } references to the linked records.
    // Screenshot (if any) is kept on the worker for review; attaching it to the
    // Teable record is a follow-up — see README "Screenshots".
    return teableCreateRecord(tableId, {
      'Frog 1': [{ id: p.frog1Id }],
      'Frog 2': [{ id: p.frog2Id }],
    });
  },
};
