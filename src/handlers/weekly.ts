import { z } from 'zod';
import type { SubmissionHandler } from '../types';
import { resolveFieldId, teableCreateRecordById, teableGetMaxNumber } from '../teable';
import { config } from '../config';

// Mirrors getCurrentISOWeek() on the frontend. Calculated at approval time so
// the stored date always reflects the actual active week, not the submission date.
function getCurrentISOWeek(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'long', hour: 'numeric', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const year    = parseInt(get('year'),  10);
  const month   = parseInt(get('month'), 10);
  const day     = parseInt(get('day'),   10);
  const weekday = get('weekday');
  const hour    = parseInt(get('hour') || '12', 10) % 24;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (weekday === 'Monday' && hour < 14) d.setUTCDate(d.getUTCDate() - 7);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

const FROG_SLOTS = ['NameA', 'NameB', 'NameC', 'NameD', 'NameE', 'NameF', 'NameG', 'NameH'] as const;

// SetDate field ID (fld0g2OJuIM4fScLjfS) is hardcoded since we write via
// fieldKeyType=id and we know the ID won't change even if the display name does.
const SET_DATE_FIELD_ID   = 'fld0g2OJuIM4fScLjfS';
const SET_CHRON_FIELD_ID  = 'fldaGzZa0KXnxP6HHYm';
const STAMP_FIELD_ID_A    = 'fld4Ydpj2Q4PWFu5B5K';
const STAMP_FIELD_ID_B    = 'fldO6PVSdLA2sOAOkdc';

export const weeklySchema = z.object({
  setName: z.string().min(1).max(120),
  reward:  z.number().int().positive(),
  frogs:   z.array(z.string().min(1).max(120)).min(4).max(8),
});

export type WeeklyPayload = z.infer<typeof weeklySchema>;

export const weeklyHandler: SubmissionHandler<WeeklyPayload> = {
  type:  'weekly',
  label: 'Weekly Set',
  schema: weeklySchema,
  summarize: (p) =>
    `${p.setName} — ${p.frogs.length} frog${p.frogs.length !== 1 ? 's' : ''}, ${p.reward} stamps`,

  async pushDown(p) {
    const tableId  = config.teable.tables.weekly;
    const nextChron = (await teableGetMaxNumber(tableId, SET_CHRON_FIELD_ID)) + 1;
    const fields: Record<string, unknown> = {
      [await resolveFieldId(tableId, { name: 'SetName' })]: p.setName,
      [SET_DATE_FIELD_ID]:   getCurrentISOWeek(),
      [SET_CHRON_FIELD_ID]:  nextChron,
      [STAMP_FIELD_ID_A]:    p.reward,
      [STAMP_FIELD_ID_B]:    p.reward,
    };
    for (let i = 0; i < p.frogs.length; i++) {
      fields[await resolveFieldId(tableId, { name: FROG_SLOTS[i] })] = p.frogs[i];
    }
    return teableCreateRecordById(tableId, fields);
  },
};
